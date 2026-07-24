import { Router, type Request } from "express";
import multer from "multer";
import { OfficeConverter } from "officeparser";
import { requireAuth, type AuthPayload } from "../middlewares/auth";
import { db } from "@workspace/db";
import { authorizedUsersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — eğitim dokümanları için yeterli, sunucuyu boğmaz
});

// Dosya adı uzantısından officeparser'a doğru tip ipucunu veriyoruz — sadece
// buffer'dan magic-byte tahminine güvenmek yerine (docx/pptx/xlsx hepsi zip
// tabanlı olduğu için karışabilir) daha güvenilir.
const EXT_TO_TYPE: Record<string, string> = {
  pdf: "pdf", doc: "docx", docx: "docx", ppt: "pptx", pptx: "pptx", xls: "xlsx", xlsx: "xlsx",
};

const router = Router();

/* =========================
   GROQ
========================= */
async function askGroq(messages: any[], temperature = 0.5) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature,
    }),
  });

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;

  if (!text) throw new Error("AI boş cevap");

  return text;
}

/* =========================
   ELEVENLABS TTS (Sesli Sorular)
========================= */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Duygu etiketleri (Türkçe arayüz -> Eleven v3'ün anladığı İngilizce audio tag).
// Not: v3 modeli metnin İÇİNE gömülü [tag] işaretlerini "ses yönetmenliği"
// talimatı olarak okuyor; metin Türkçe kalırken etiketin kendisi İngilizce
// kalıyor — bu, ElevenLabs'ın belgelenmiş kullanım şekli.
const EMOTION_TAGS: Record<string, string> = {
  notr: "",
  korkmus: "fearful",
  sinirli: "angry",
  endiseli: "nervous",
  mutlu: "happy",
  uzgun: "sad",
  sakin: "calm",
  saskin: "surprised",
  aceleci: "rushed",
};

// Ses listesini her istekte ElevenLabs'tan çekmek yerine kısa süreliğine
// önbellekte tutuyoruz — hesaptaki ses listesi neredeyse hiç değişmez, bu da
// gereksiz dış API çağrısını (ve olası gecikmeyi) önler.
let voicesCache: { data: unknown; ts: number } | null = null;
const VOICES_CACHE_MS = 10 * 60 * 1000;

router.get("/tts-voices", requireAuth, async (_req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: "Sesli soru özelliği için sunucuda ELEVENLABS_API_KEY tanımlı değil." });
  }

  if (voicesCache && Date.now() - voicesCache.ts < VOICES_CACHE_MS) {
    return res.json(voicesCache.data);
  }

  try {
    const r = await fetch(`${ELEVENLABS_BASE}/voices`, {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      logger.error({ status: r.status, errText }, "ElevenLabs ses listesi alınamadı");
      return res.status(502).json({ error: "Ses listesi alınamadı. API anahtarını kontrol edin." });
    }
    const json: any = await r.json();
    const voices = (json.voices || []).map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      gender: v.labels?.gender || null,
      age: v.labels?.age || null,
      accent: v.labels?.accent || null,
      description: v.labels?.description || v.description || null,
      previewUrl: v.preview_url || null,
    }));
    voicesCache = { data: voices, ts: Date.now() };
    return res.json(voices);
  } catch (e) {
    logger.error({ err: e }, "Ses listesi alınırken hata");
    return res.status(500).json({ error: "Ses listesi alınamadı." });
  }
});

router.post("/tts-generate", requireAuth, async (req, res) => {
  const user = (req as Request & { user: AuthPayload }).user;
  const { text, voiceId, emotion } = req.body as { text: string; voiceId: string; emotion?: string };

  if (!text || !text.trim()) {
    return res.status(400).json({ error: "Seslendirilecek metin gerekli." });
  }
  if (!voiceId) {
    return res.status(400).json({ error: "Bir ses seçmelisiniz." });
  }
  if (text.length > 600) {
    return res.status(400).json({ error: "Metin çok uzun (en fazla 600 karakter). Daha kısa bir senaryo yazın." });
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: "Sesli soru özelliği için sunucuda ELEVENLABS_API_KEY tanımlı değil." });
  }

  const tag = emotion ? EMOTION_TAGS[emotion] : "";
  const finalText = tag ? `[${tag}] ${text.trim()}` : text.trim();

  try {
    const r = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text: finalText,
        model_id: "eleven_v3",
        language_code: "tr",
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      logger.error({ status: r.status, errText }, "ElevenLabs TTS üretimi başarısız");
      return res.status(502).json({ error: "Ses üretilemedi. ElevenLabs API'sinden hata döndü." });
    }

    const arrayBuf = await r.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString("base64");

    // AI kullanım sayacı — sesli soru üretimi de bir AI sorgusu sayılır
    // (sohbet içeriği değil, sadece sayaç — mevcut /chat davranışıyla tutarlı).
    db.update(authorizedUsersTable)
      .set({ aiQueryCount: sql`COALESCE(ai_query_count, 0) + 1` })
      .where(sql`sicil = ${user.sicil}`)
      .catch(() => {});

    res.json({ audioData: `data:audio/mpeg;base64,${base64}` });
    return;
  } catch (e) {
    logger.error({ err: e }, "TTS üretimi sırasında hata");
    return res.status(500).json({ error: "Ses üretilemedi." });
  }
});

/* =========================
   QUIZ GENERATION
========================= */

type RawAnswer = { text: string; correct: boolean };
type RawQuestion = { text: string; answers: RawAnswer[] };

function normalize(s: string) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Per-question problems: wrong answer count, empty text, duplicate answer text,
// or anything other than exactly one correct answer.
function questionIssues(q: RawQuestion): string[] {
  const issues: string[] = [];
  if (!q?.text?.trim() || !Array.isArray(q.answers)) return ["eksik alan"];
  if (q.answers.length !== 4) issues.push(`4 şık yok (${q.answers.length})`);

  const correctCount = q.answers.filter(a => a?.correct).length;
  if (correctCount !== 1) issues.push(`doğru cevap sayısı ${correctCount}`);

  const seen = new Set<string>();
  for (const a of q.answers) {
    const norm = normalize(a?.text);
    if (!norm) { issues.push("boş şık"); continue; }
    if (seen.has(norm)) issues.push(`iki şık aynı ("${a.text}")`);
    seen.add(norm);
  }
  return issues;
}

// Batch-level: flags questions that are near-duplicates of an earlier one in the same set.
function duplicateQuestionIndexes(questions: RawQuestion[]): Set<number> {
  const seen = new Set<string>();
  const dupes = new Set<number>();
  questions.forEach((q, i) => {
    const norm = normalize(q?.text);
    if (!norm) return;
    if (seen.has(norm)) dupes.add(i);
    seen.add(norm);
  });
  return dupes;
}

function findIssues(questions: RawQuestion[]): string[] {
  if (!Array.isArray(questions) || questions.length === 0) return ["Soru listesi boş"];
  const issues: string[] = [];
  const dupes = duplicateQuestionIndexes(questions);
  questions.forEach((q, i) => {
    const qIssues = questionIssues(q);
    qIssues.forEach(msg => issues.push(`Soru ${i + 1}: ${msg}`));
    if (dupes.has(i)) issues.push(`Soru ${i + 1}: başka bir soruyla neredeyse aynı`);
  });
  return issues;
}

// Keeps only the individually valid, non-duplicate questions from a batch.
// Used as a last-resort fallback so one bad question doesn't fail the whole request.
function keepValidQuestions(questions: RawQuestion[]): RawQuestion[] {
  const dupes = duplicateQuestionIndexes(questions);
  return questions.filter((q, i) => !dupes.has(i) && questionIssues(q).length === 0);
}

// Fisher–Yates via swaps only — never overwrites a slot's contents. The previous
// version overwrote a random slot with a *copy* of the correct answer instead of
// moving it, which left the original copy behind too — that was the "two identical
// choices" bug.
function shuffle<T>(arr: T[]) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Spreads the correct answer's position evenly across A/B/C/D over the whole batch
// instead of leaving it to per-question chance, which tends to clump on one letter.
function balanceCorrectPositions(questions: RawQuestion[]) {
  const n = questions.length;
  const pool: number[] = [];
  for (let i = 0; i < n; i++) pool.push(i % 4);
  shuffle(pool);

  questions.forEach((q, i) => {
    shuffle(q.answers); // randomize distractor order + correct's starting spot
    const targetIdx = pool[i];
    const currentIdx = q.answers.findIndex(a => a.correct);
    if (currentIdx !== -1 && currentIdx !== targetIdx) {
      // swap, not overwrite — both answers keep their own (distinct) text
      [q.answers[currentIdx], q.answers[targetIdx]] = [q.answers[targetIdx], q.answers[currentIdx]];
    }
  });
}

function buildSystemPrompt(count: number, topic: string) {
  return `Sen bir eğitim uzmanısın ve Türkçe quiz soruları hazırlıyorsun.

GÖREVIN:
"${topic}" konusuyla doğrudan ilgili, eğitici ve zorlayıcı ${count} adet çoktan seçmeli soru üret.

ÇEŞİTLİLİK KURALLARI (ÇOK ÖNEMLİ):
- Üretilen ${count} sorunun HİÇBİRİ birbirine benzemesin; her biri konunun FARKLI bir alt başlığını, olayını, tarihini veya detayını sorsun
- Aynı bilgiyi farklı cümlelerle tekrar sorma
- Sorular birbirinin ardına aynı kalıpla başlamasın (hepsi "... nedir?" gibi olmasın, soru tiplerini çeşitlendir)

SORU KALİTESİ KURALLARI:
- Her soru net, anlaşılır ve tek bir şeyi sorduğundan emin ol
- Sorular yüzeysel değil, konuyu gerçekten bilen birini sınayacak nitelikte olsun
- Türkçe dil bilgisi kurallarına tam uy
- Soru kökünde belirsizlik veya çift anlam olmasın

ŞIKLAR İÇİN KURALLAR (ÇOK ÖNEMLİ):
- Tam olarak 4 şık olacak, bunlardan SADECE 1 tanesi doğru (correct: true) olacak
- Bir sorunun 4 şıkkı birbirinden MUTLAKA farklı olacak — aynı metne sahip iki şık KESİNLİKLE OLMAYACAK, bunu iki kez kontrol et
- A, B, C, D harflerini YAZMA — sadece şık metni yaz, sıralama uygulama tarafında ayrıca yapılacak
- Yanlış şıklar mantıklı ve yanıltıcı olsun; "saçma" veya "belli ki yanlış" şık koyma
- Tüm şıklar benzer uzunlukta ve benzer formatta olsun

ÇIKTI KURALLARI:
- Yalnızca ham JSON döndür, başka hiçbir metin yazma
- Kod bloğu, açıklama, "işte sorular" gibi ifade ekleme
- JSON dışında tek karakter bile olmamalı

FORMAT (kesinlikle bu yapıya uy):
[
  {
    "text": "Soru metni buraya",
    "answers": [
      {"text": "Birinci şık", "correct": false},
      {"text": "İkinci şık", "correct": true},
      {"text": "Üçüncü şık", "correct": false},
      {"text": "Dördüncü şık", "correct": false}
    ]
  }
]`;
}

function buildDocumentSystemPrompt(count: number) {
  return `Sen bir eğitim uzmanısın ve Türkçe quiz soruları hazırlıyorsun.

GÖREVIN:
Sana bir eğitim dokümanından çıkarılmış ham metin verilecek. Bu metnin İÇERİĞİNE dayanarak, o dokümanı
gerçekten okuyup anlamış birini sınayacak ${count} adet çoktan seçmeli soru üret.

ÇOK ÖNEMLİ — KAYNAK SADAKATİ:
- Sorular SADECE verilen doküman metninden çıkmalı. Kendi genel bilgini kullanıp dokümanda olmayan bir konuda
  soru UYDURMA.
- Yanlış şıklar da mantıklı olsun ama doğru şıkkın metinde açıkça karşılığı olmalı.
- Doküman metni ${count} soru için yeterli, birbirinden bağımsız fikir/bilgi içermiyorsa, daha AZ ama gerçekten
  metne dayanan soru üret — sayıyı tutturmak için tekrar eden ya da metinde olmayan soru uydurma.
- Doküman tablo, madde işaretli liste veya rakamsal bilgi (tarih, oran, süre, tutar) içeriyorsa bunları soru
  konusu yapmayı özellikle tercih et — bu tür somut bilgiler en iyi test edilebilir olanlardır.

ÇEŞİTLİLİK KURALLARI:
- Üretilen soruların HİÇBİRİ birbirine benzemesin; her biri metnin FARKLI bir kısmını/detayını sorsun
- Art arda aynı kalıpla başlayan sorular yazma

ŞIKLAR İÇİN KURALLAR (ÇOK ÖNEMLİ):
- Tam olarak 4 şık olacak, bunlardan SADECE 1 tanesi doğru (correct: true) olacak
- Bir sorunun 4 şıkkı birbirinden MUTLAKA farklı olacak — aynı metne sahip iki şık KESİNLİKLE OLMAYACAK
- A, B, C, D harflerini YAZMA — sadece şık metni yaz
- Yanlış şıklar mantıklı ve yanıltıcı olsun; "saçma" veya "belli ki yanlış" şık koyma

ÇIKTI KURALLARI:
- Yalnızca ham JSON döndür, başka hiçbir metin yazma
- Kod bloğu, açıklama, "işte sorular" gibi ifade ekleme

FORMAT (kesinlikle bu yapıya uy):
[
  {
    "text": "Soru metni buraya",
    "answers": [
      {"text": "Birinci şık", "correct": false},
      {"text": "İkinci şık", "correct": true},
      {"text": "Üçüncü şık", "correct": false},
      {"text": "Dördüncü şık", "correct": false}
    ]
  }
]`;
}

// /generate-quiz (konu bazlı) ve /generate-quiz-from-file (doküman bazlı) aynı
// üretim + doğrulama + tekrar deneme + şık dengeleme mantığını paylaşıyor —
// aralarındaki tek fark sistem promptu ve ilk kullanıcı mesajı.
async function generateValidatedQuestions(systemPromptText: string, baseUserMessage: string, count: number) {
  const MAX_ATTEMPTS = 3;
  let lastIssues: string[] = [];
  let lastJson: RawQuestion[] | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userNote = lastIssues.length
      ? `${baseUserMessage}\n\nÖnceki denemede şu sorunlar vardı, bunları KESİNLİKLE tekrarlama:\n${lastIssues.join("\n")}`
      : baseUserMessage;

    const raw = await askGroq(
      [
        { role: "system", content: systemPromptText },
        { role: "user", content: userNote },
      ],
      0.8
    );

    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) {
      lastIssues = ["JSON bulunamadı, sadece ham JSON dizisi döndürülmeliydi"];
      continue;
    }

    let json: RawQuestion[];
    try {
      json = JSON.parse(match[0]);
    } catch {
      lastIssues = ["JSON parse hatası, format bozuktu"];
      continue;
    }

    lastJson = json;
    const issues = findIssues(json);
    if (issues.length === 0) {
      balanceCorrectPositions(json);
      return { questions: json };
    }

    lastIssues = issues;
    logger.warn({ attempt, issues }, "AI soru üretimi doğrulamadan geçemedi, tekrar deneniyor");
  }

  if (lastJson) {
    const salvaged = keepValidQuestions(lastJson);
    if (salvaged.length > 0) {
      balanceCorrectPositions(salvaged);
      logger.warn(
        { requested: count, salvaged: salvaged.length },
        "AI soru üretimi tam istenen sayıda temiz soru üretemedi, geçerli olanlar döndürülüyor"
      );
      return { questions: salvaged, warning: `${count} sorudan ${salvaged.length} tanesi kalite kontrolünden geçti.` };
    }
  }

  return { error: "AI kaliteli soru üretemedi, lütfen tekrar deneyin.", issues: lastIssues };
}

router.post("/generate-quiz", requireAuth, async (req, res) => {
  const { topic, count = 5 } = req.body;

  if (!topic) {
    return res.status(400).json({ error: "Konu gerekli" });
  }

  try {
    const systemPromptText = buildSystemPrompt(count, topic);
    const result = await generateValidatedQuestions(systemPromptText, `Konu: ${topic}\n\nLütfen ${count} soru üret.`, count);
    if ("error" in result) return res.status(500).json(result);
    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Maksimum doküman metni uzunluğu (karakter). Groq'un ücretsiz katmanındaki
// dakika başı token limiti sınırlı olduğundan (sistem promptu + doküman +
// üretilen JSON cevabı hepsi aynı bütçeden düşüyor), çok büyük dokümanları
// tamamını göndermek yerine baştan kırpıyoruz. ~8000 karakter kabaca 2000
// token'a denk gelir, güvenli bir sınır.
const MAX_DOCUMENT_CHARS = 8000;

router.post("/generate-quiz-from-file", requireAuth, upload.single("file"), async (req, res) => {
  const file = req.file;
  const count = parseInt(req.body?.count) || 8;

  if (!file) {
    return res.status(400).json({ error: "Dosya gerekli" });
  }

  const ext = (file.originalname.split(".").pop() || "").toLowerCase();
  const type = EXT_TO_TYPE[ext];
  if (!type) {
    return res.status(400).json({ error: "Desteklenmeyen dosya türü. PDF, Word (.docx), Excel (.xlsx) veya PowerPoint (.pptx) yükleyin." });
  }

  let documentText: string;
  try {
    const result = await OfficeConverter.convert(file.buffer, "text", { parseConfig: { fileType: type as any, ocr: false } });
    documentText = String(result?.value || "").trim();
  } catch (e) {
    logger.error({ err: e }, "Doküman metni çıkarılamadı");
    return res.status(400).json({ error: "Dosyadan metin çıkarılamadı. Dosyanın bozuk olmadığından emin olun." });
  }

  if (documentText.length < 50) {
    return res.status(400).json({ error: "Dosyada yeterli metin bulunamadı (taranmış/görsel tabanlı bir dosya olabilir)." });
  }

  const truncated = documentText.length > MAX_DOCUMENT_CHARS;
  const usedText = documentText.slice(0, MAX_DOCUMENT_CHARS);

  try {
    const systemPromptText = buildDocumentSystemPrompt(count);
    const userMessage = `Doküman metni (${file.originalname}${truncated ? ", uzun olduğu için baştan kırpıldı" : ""}):\n\n"""\n${usedText}\n"""\n\nLütfen bu metnin içeriğine dayanarak en fazla ${count} soru üret.`;
    const result = await generateValidatedQuestions(systemPromptText, userMessage, count);
    if ("error" in result) return res.status(500).json(result);
    return res.json({ ...result, truncated, sourceFileName: file.originalname });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

/* =========================
   CHAT / ANALYTICS
========================= */

const SESSION_SAMPLE_SIZE = 50;

// Pulls recent finished sessions and derives rich, grounded statistics
// (per-question performance, per-session winners, category breakdown,
// real unique-participant counts, registered users vs who has hosted) so
// the assistant reasons from real numbers instead of guessing/estimating —
// every number handed to the model here is something it can quote directly
// without inventing anything.
async function buildAnalyticsContext() {
  let overview = "Veri alınamadı";
  let hosts = "Veri alınamadı";
  let sessionInsights = "Veri alınamadı";
  let categoryStats = "Veri alınamadı";
  let userStats = "Veri alınamadı";

  try {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int as total_sessions,
        COALESCE(SUM(player_count),0)::int as total_player_slots,
        COALESCE(MAX(player_count),0)::int as max_players_in_one_session,
        COALESCE(AVG(player_count),0)::float as avg_players_per_session
      FROM game_sessions
    `);
    overview = JSON.stringify(result.rows[0]);
  } catch {
    overview = "Veritabanına erişilemedi";
  }

  try {
    const topHosts = await db.execute(sql`
      SELECT host_sicil, COUNT(*)::int as session_count
      FROM game_sessions
      WHERE host_sicil IS NOT NULL
      GROUP BY host_sicil
      ORDER BY session_count DESC
      LIMIT 10
    `);
    hosts = JSON.stringify(topHosts.rows);
  } catch {
    hosts = "Veritabanına erişilemedi";
  }

  try {
    const catRows = await db.execute(sql`
      SELECT COALESCE(category, 'Kategorisiz') as category, COUNT(*)::int as session_count
      FROM game_sessions
      GROUP BY category
      ORDER BY session_count DESC
    `);
    categoryStats = JSON.stringify(catRows.rows);
  } catch {
    categoryStats = "Veritabanına erişilemedi";
  }

  // Kayıtlı (yetkilendirilmiş) kullanıcılardan hangileri hiç host olarak
  // oturum açmamış — "kim hiç sınav başlatmadı" gibi sorulara gerçek veriyle
  // cevap verebilmek için.
  try {
    const allUsers = await db.select().from(authorizedUsersTable);
    const hostRows = await db.execute(sql`SELECT DISTINCT host_sicil FROM game_sessions WHERE host_sicil IS NOT NULL`);
    const hostedSicils = new Set((hostRows.rows as { host_sicil: string }[]).map(r => r.host_sicil));
    const neverHosted = allUsers
      .filter((u: typeof allUsers[number]) => !hostedSicils.has(u.sicil))
      .map((u: typeof allUsers[number]) => `${u.sicil} (${u.adSoyad})`);
    userStats = JSON.stringify({
      totalRegisteredUsers: allUsers.length,
      registeredUsersWhoNeverHosted: neverHosted,
    });
  } catch {
    userStats = "Veritabanına erişilemedi";
  }

  try {
    const recent = await db.execute(sql`
      SELECT title, category, host_sicil, question_count, player_count, questions, results, started_at, ended_at
      FROM game_sessions
      ORDER BY ended_at DESC NULLS LAST
      LIMIT ${SESSION_SAMPLE_SIZE}
    `);

    type Row = {
      title: string | null;
      category: string | null;
      host_sicil: string | null;
      question_count: number | null;
      player_count: number | null;
      questions: Array<{ text: string; answers: { text: string; correct: boolean }[]; questionType?: string; voiceScript?: string }> | null;
      results: { leaderboard?: { name: string; score: number }[]; playerAnswers?: { name: string; score: number; answers: Record<number, { choice: number }> }[] } | null;
      started_at: string | null;
      ended_at: string | null;
    };

    const rows = recent.rows as unknown as Row[];

    // Per-question correctness rate, aggregated across all sampled sessions.
    const questionStats = new Map<string, { correct: number; total: number }>();
    const sessionSummaries: string[] = [];
    const allParticipantNames = new Set<string>();

    for (const row of rows) {
      const questions = row.questions || [];
      const playerAnswers = row.results?.playerAnswers || [];
      const leaderboard = row.results?.leaderboard || [];

      leaderboard.forEach(p => allParticipantNames.add(p.name?.trim().toLowerCase()));

      const avgScore = leaderboard.length
        ? Math.round(leaderboard.reduce((s, p) => s + (p.score || 0), 0) / leaderboard.length)
        : 0;
      const winner = leaderboard.length
        ? [...leaderboard].sort((a, b) => b.score - a.score)[0]
        : null;
      const durationMin = row.started_at && row.ended_at
        ? Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000)
        : null;
      const dateStr = row.ended_at ? new Date(row.ended_at).toLocaleDateString("tr-TR") : "tarih yok";

      sessionSummaries.push(
        `"${row.title || "(başlıksız)"}" [${row.category || "kategorisiz"}] — ${dateStr}, host: ${row.host_sicil || "?"}, ${row.player_count ?? 0} katılımcı, ${row.question_count ?? 0} soru, ort. skor ${avgScore}${durationMin !== null ? `, süre ${durationMin} dk` : ""}${winner ? `, birinci: ${winner.name} (${winner.score} puan)` : ""}`
      );

      questions.forEach((q, qIdx) => {
        const correctIdx = q.answers?.findIndex(a => a.correct) ?? -1;
        if (correctIdx === -1) return;
        let correct = 0, total = 0;
        for (const p of playerAnswers) {
          const ans = p.answers?.[qIdx];
          if (ans === undefined) continue;
          total++;
          if (ans.choice === correctIdx) correct++;
        }
        if (total === 0) return;
        // Rapor ile tutarlı olsun diye: sesli sorularda senaryo metnini de
        // ekliyoruz, sadece "gösterilen" kısa soru metnine güvenmiyoruz.
        const key = (q.questionType === "voice" && q.voiceScript)
          ? `"${q.voiceScript}" — ${q.text?.trim()}`
          : q.text?.trim();
        if (!key) return;
        const existing = questionStats.get(key) || { correct: 0, total: 0 };
        existing.correct += correct;
        existing.total += total;
        questionStats.set(key, existing);
      });
    }

    const questionRates = [...questionStats.entries()]
      .map(([text, s]) => ({ text, rate: Math.round((s.correct / s.total) * 100), sampleSize: s.total }))
      .sort((a, b) => a.rate - b.rate);

    const hardest = questionRates.slice(0, 8);
    const easiest = questionRates.slice(-8).reverse();

    sessionInsights = JSON.stringify({
      sampledSessionCount: rows.length,
      note: `Bu sadece en son ${SESSION_SAMPLE_SIZE} oturuma bakıyor, tüm zamanların verisi değil.`,
      uniqueParticipantNamesInSample: allParticipantNames.size,
      recentSessions: sessionSummaries,
      hardestQuestions: hardest,
      easiestQuestions: easiest,
    });
  } catch (e) {
    logger.error({ err: e }, "Analytics context oluşturulamadı");
    sessionInsights = "Veritabanına erişilemedi";
  }

  return { overview, hosts, sessionInsights, categoryStats, userStats };
}

router.post("/chat", requireAuth, async (req, res) => {
  const { message } = req.body;
  const user = (req as Request & { user: AuthPayload }).user;

  if (!message) {
    return res.status(400).json({ error: "Mesaj gerekli" });
  }

  // Sadece bir sayaç — kullanıcının AI'ya ne sorduğunu/ne yaptığını DB'ye
  // kaydetmiyoruz (bilinçli tercih: DB'yi şişirmemek ve gizlilik için).
  // "AI kullanım yüzdesi" gibi bir özet için bu sayaç yeterli.
  db.update(authorizedUsersTable)
    .set({ aiQueryCount: sql`COALESCE(ai_query_count, 0) + 1` })
    .where(sql`sicil = ${user.sicil}`)
    .catch(() => {});

  const { overview, hosts, sessionInsights, categoryStats, userStats } = await buildAnalyticsContext();

  const systemPrompt = `Sen AssisTT Quiz Time platformunun analiz ve destek asistanısın. Bu platformda eğitmenler
farklı projeler (TT Mobil, TTNET, Özel Projeler, Yetkinlik, Buz Kırıcı) için canlı quiz/sınav oturumları açıyor.

GÖREVIN İKİ TÜRLÜ SORUYA CEVAP VERMEK:

1) VERİ SORULARI (istatistik, performans, kim/ne/ne zaman): Aşağıda verilen gerçek platform verilerini kullan.
2) UYGULAMA KULLANIMI SORULARI ("nasıl yaparım", "X'i nereden değiştiririm" gibi): Aşağıdaki "UYGULAMA REHBERİ"
   bölümündeki bilgiyle kısa, pratik bir yönlendirme yap — bunlar veri sorusu değil, arayüz sorusu, öyle davran.

VERİ SORULARINA CEVAP VERİRKEN:
- SADECE aşağıda verilen gerçek verileri kullan, kesinlikle sayı/istatistik uydurma
- Elindeki veri tam istenen soruyu karşılamıyorsa ama YAKIN bir şeyi cevaplayabiliyorsan (örn. "sınavın konusu
  neydi" sorusuna açık bir "konu" alanı yoksa bile soru metinlerinden makul bir konu çıkarımı yap), önce bunu
  dene — direkt "veri yok" deyip bırakma. Çıkarım yaptığında bunun bir çıkarım olduğunu belirt, ama YİNE DE bir
  cevap ver.
- Gerçekten elinde hiçbir ipucu yoksa bunu açıkça söyle, ama kısa tut ve mümkünse alternatif bir soru öner
  (örn. "bu bilgiyi tutmuyoruz ama X'i sorarsan cevaplayabilirim" gibi)
- Analiz sadece son ${SESSION_SAMPLE_SIZE} oturuma bakıyor — eğer soru "bugüne kadar" gibi tüm zamanları
  kapsıyorsa ve elindeki veri örneklem tabanlıysa, bunu bir cümleyle belirt
- Kısa, net ve Türkçe yanıt ver; gerektiğinde madde madde yaz, gereksiz uzatma
- Somut ol: isim, sayı, oran ver — "bazı sorular zor" gibi belirsiz ifadelerden kaçın

VERİ KAPSAMI DIŞINDA KALANLAR (bunlar sorulursa dürüstçe söyle, uydurma):
- Katılımcıların hangi cihazdan (mobil/masaüstü) bağlandığı takip edilmiyor — "mobil" ifadesi soruda geçiyorsa
  muhtemelen "TT Mobil" projesi/kategorisi kastediliyordur, kategori verisine bak
- Katılımcılar giriş yapmıyor, sadece isim yazıp katılıyor — bu yüzden bir kişinin farklı oturumlardaki
  performansını isimden başka bir şeyle eşleştiremeyiz (aynı isim farklı kişiler olabilir)
- Kayıtlı KULLANICILAR (host/editör yetkisi olanlar) ayrı bir şey, sınav KATILIMCILARI ayrı bir şey — biri
  giriş yapan hesap sahipleri, diğeri sınava katılan (giriş yapmayan) kişiler, birbirine karıştırma

UYGULAMA REHBERİ (kullanıcı "nasıl yaparım" tarzı bir şey sorarsa buradan yanıtla):
- Kullanıcı ekleme/silme/yetki değiştirme → üstteki "👥 Kullanıcılar" butonu (sadece admin görür)
- Geçmiş sınav raporu indirme (Excel) → üstteki "📊 Raporlar" butonu
- Bir sınava otomatik geribildirim ekleme → "Lobiyi Başlat" penceresindeki "🎯 Geribildirim Oluştur" butonu
- Soruları projeye göre kategorize etme → hem kütüphaneye kaydederken hem "Lobiyi Başlat" penceresinde
  "Proje/Kategori" seçilir
- Excel'den toplu soru yükleme → soru düzenleme ekranındaki "📊 Excel Yükle" butonu
- Not: Yetki değiştirme gibi bir İŞLEMİ senin üzerinden YAPAMAYIZ, sadece nereden yapılacağını gösterebiliriz.

PLATFORM VERİLERİ:
Genel istatistik (tüm zamanlar): ${overview}
En aktif hostlar — sicil → oturum sayısı (tüm zamanlar): ${hosts}
Kayıtlı kullanıcı sayısı ve hiç host olmamış kullanıcılar: ${userStats}
Kategori/proje bazında oturum sayıları (tüm zamanlar): ${categoryStats}
Son ${SESSION_SAMPLE_SIZE} oturumun detayı — her oturumun kategorisi, host'u, katılımcı sayısı, ortalama skoru,
o oturumun BİRİNCİSİ (isim+puan), ve tüm örneklemdeki en zor/en kolay sorular + benzersiz katılımcı ismi sayısı: ${sessionInsights}`;

  try {
    const reply = await askGroq(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      0.3
    );

    return res.json({ reply });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
