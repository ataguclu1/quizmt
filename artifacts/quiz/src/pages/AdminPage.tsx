import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { getUsers, addUser, deleteUser, getQuestionSets, deleteQuestionSet, createQuestionSet, type QuestionSet, type Question } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import QuestionSetUploader from "@/components/QuestionSetUploader";
import HostGame from "@/components/HostGame";

interface User {
  id: number;
  sicil: string;
  adSoyad: string;
  yetki: string;
}

export default function AdminPage() {
  const { user, logout } = useAuth();
  const token = user!.token;

  const [users, setUsers] = useState<User[]>([]);
  const [qSets, setQSets] = useState<QuestionSet[]>([]);
  const [newSicil, setNewSicil] = useState("");
  const [newAdSoyad, setNewAdSoyad] = useState("");
  const [newYetki, setNewYetki] = useState("full");
  const [userError, setUserError] = useState("");
  const [userLoading, setUserLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("users");

  useEffect(() => {
    loadUsers();
    loadQSets();
  }, []);

  async function loadUsers() {
    try {
      const data = await getUsers(token);
      setUsers(data);
    } catch {}
  }

  async function loadQSets() {
    try {
      const data = await getQuestionSets(token);
      setQSets(data);
    } catch {}
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setUserError("");
    setUserLoading(true);
    try {
      await addUser(token, newSicil.toUpperCase(), newAdSoyad, newYetki);
      setNewSicil("");
      setNewAdSoyad("");
      setNewYetki("full");
      await loadUsers();
    } catch (err: unknown) {
      setUserError(err instanceof Error ? err.message : "Hata oluştu.");
    } finally {
      setUserLoading(false);
    }
  }

  async function handleDeleteUser(sicil: string) {
    if (!confirm(`${sicil} sicilli kullanıcıyı silmek istediğinize emin misiniz?`)) return;
    try {
      await deleteUser(token, sicil);
      await loadUsers();
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
            <p className="text-violet-200 text-sm">Yönetici Paneli · {user!.adSoyad}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={logout} className="text-white border-white hover:bg-violet-600">
          Çıkış
        </Button>
      </header>

      <div className="max-w-5xl mx-auto p-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="users">👥 Kullanıcı Yönetimi</TabsTrigger>
            <TabsTrigger value="questions">📋 Soru Setleri</TabsTrigger>
            <TabsTrigger value="host">🎮 Oyun Başlat</TabsTrigger>
          </TabsList>

          <TabsContent value="users">
            <div className="grid md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Yeni Kullanıcı Ekle</CardTitle>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleAddUser} className="space-y-4">
                    <div className="space-y-1">
                      <Label>Sicil Numarası</Label>
                      <Input
                        placeholder="Örn: B012345"
                        value={newSicil}
                        onChange={e => setNewSicil(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Ad Soyad</Label>
                      <Input
                        placeholder="Ad Soyad"
                        value={newAdSoyad}
                        onChange={e => setNewAdSoyad(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Yetki</Label>
                      <Select value={newYetki} onValueChange={setNewYetki}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="full">Tam Yetki (Soru yükle/sil + Oyun başlat)</SelectItem>
                          <SelectItem value="limited">Sınırlı (Sadece Oyun Başlat)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {userError && <p className="text-sm text-red-500">{userError}</p>}
                    <Button type="submit" className="w-full" disabled={userLoading}>
                      {userLoading ? "Ekleniyor..." : "Kullanıcı Ekle"}
                    </Button>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Kayıtlı Kullanıcılar</CardTitle>
                </CardHeader>
                <CardContent>
                  {users.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">Henüz kullanıcı yok.</p>
                  ) : (
                    <div className="space-y-2">
                      {users.map(u => (
                        <div key={u.id} className="flex items-center gap-2 p-3 rounded-lg border bg-white">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{u.adSoyad}</p>
                            <p className="text-xs text-muted-foreground">{u.sicil}</p>
                          </div>
                          <Badge variant={u.yetki === "full" ? "default" : "secondary"} className="text-xs">
                            {u.yetki === "full" ? "Tam Yetki" : "Sınırlı"}
                          </Badge>
                          <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => handleDeleteUser(u.sicil)}>
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
