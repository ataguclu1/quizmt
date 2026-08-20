import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { getQuestionSets, deleteQuestionSet, createQuestionSet, type QuestionSet, type Question } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import QuestionSetUploader from "@/components/QuestionSetUploader";
import HostGame from "@/components/HostGame";

export default function FullUserPage() {
  const { user, logout } = useAuth();
  const token = user!.token;
  const [qSets, setQSets] = useState<QuestionSet[]>([]);

  useEffect(() => { loadQSets(); }, []);

  async function loadQSets() {
    try {
      const data = await getQuestionSets(token);
      setQSets(data);
    } catch {}
  }

  async function handleUpload(name: string, questions: Question[]) {
    await createQuestionSet(token, name, questions);
    await loadQSets();
  }

  async function handleDeleteQSet(id: number, name: string) {
    if (!confirm(`"${name}" soru setini silmek istediğinize emin misiniz?`)) return;
    try {
      await deleteQuestionSet(token, id);
      await loadQSets();
    } catch {}
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-violet-700 text-white px-6 py-4 flex justify-between items-center shadow">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🎯</span>
          <div>
            <h1 className="font-bold text-lg">AssisTT Quiz Time</h1>
            <p className="text-violet-200 text-sm">{user!.adSoyad} · Tam Yetki</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={logout} className="text-white border-white hover:bg-violet-600">
          Çıkış
        </Button>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        <Tabs defaultValue="questions">
          <TabsList className="mb-6">
            <TabsTrigger value="questions">📋 Soru Setleri</TabsTrigger>
            <TabsTrigger value="host">🎮 Oyun Başlat</TabsTrigger>
          </TabsList>

          <TabsContent value="questions">
            <div className="space-y-6">
              <QuestionSetUploader onUpload={handleUpload} />
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Yüklü Soru Setleri ({qSets.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  {qSets.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">Henüz soru seti yok.</p>
                  ) : (
                    <div className="space-y-2">
                      {qSets.map(s => (
                        <div key={s.id} className="flex items-center gap-2 p-3 rounded-lg border bg-white">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium">{s.name}</p>
                            <p className="text-xs text-muted-foreground">{s.questions.length} soru · Yükleyen: {s.createdBy || "—"}</p>
                          </div>
                          <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => handleDeleteQSet(s.id, s.name)}>
                            Sil
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="host">
            <HostGame questionSets={qSets} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
