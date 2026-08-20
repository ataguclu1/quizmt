import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { Question } from "@/lib/api";

interface Props {
  onUpload: (name: string, questions: Question[]) => Promise<void>;
}

export default function QuestionSetUploader({ onUpload }: Props) {
  const [name, setName] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const EXAMPLE = JSON.stringify([
    {
      text: "Türkiye'nin başkenti neresidir?",
      time: 20,
      pts: "standard",
      answers: [
        { text: "Ankara", correct: true },
        { text: "İstanbul", correct: false },
        { text: "İzmir", correct: false },
        { text: "Bursa", correct: false }
      ]
    }
  ], null, 2);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setJsonText(ev.target?.result as string);
      setError("");
    };
    reader.readAsText(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSuccess(false);

    if (!name.trim()) {
      setError("Soru seti adı zorunludur.");
      return;
    }
    if (!jsonText.trim()) {
      setError("Lütfen JSON içerik girin veya dosya yükleyin.");
      return;
    }

    let questions: Question[];
    try {
      questions = JSON.parse(jsonText);
    } catch {
      setError("Geçersiz JSON formatı.");
      return;
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      setError("JSON bir soru dizisi olmalıdır.");
      return;
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.text || !Array.isArray(q.answers) || q.answers.length < 2) {
        setError(`Soru ${i + 1}: 'text' ve en az 2 şık gereklidir.`);
        return;
      }
    }

    setLoading(true);
    try {
      await onUpload(name.trim(), questions);
      setName("");
      setJsonText("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Yükleme başarısız.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Yeni Soru Seti Yükle</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <Label>Soru Seti Adı</Label>
            <Input
              placeholder="Örn: Genel Kültür - Nisan 2025"
              value={name}
              onChange={e => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1">
            <Label>JSON Dosyası Yükle</Label>
            <Input type="file" accept=".json" onChange={handleFileUpload} />
          </div>

          <div className="space-y-1">
            <Label>veya JSON İçeriği Yapıştır</Label>
            <textarea
              className="w-full min-h-[120px] border rounded-md p-3 font-mono text-xs resize-y"
              placeholder={EXAMPLE}
              value={jsonText}
              onChange={e => setJsonText(e.target.value)}
            />
          </div>

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">JSON format örneği göster</summary>
            <pre className="mt-2 p-3 bg-gray-50 rounded border overflow-auto text-xs">{EXAMPLE}</pre>
          </details>

          {error && <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded p-2">{error}</p>}
          {success && <p className="text-sm text-green-600 bg-green-50 border border-green-200 rounded p-2">✓ Soru seti başarıyla kaydedildi!</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Yükleniyor..." : "Kaydet"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
