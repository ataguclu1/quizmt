import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { login } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

const ADMIN_SICIL = "A053252";

export default function LoginPage() {
  const { login: setUser } = useAuth();
  const [sicil, setSicil] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const isAdmin = sicil === ADMIN_SICIL;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const data = await login(sicil, isAdmin ? password : undefined);
      setUser({
        token: data.token,
        sicil: data.sicil,
        adSoyad: data.adSoyad,
        role: data.role as "admin" | "full" | "limited",
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Giriş başarısız.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-violet-600 to-indigo-700 p-4">
      <Card className="w-full max-w-sm shadow-2xl">
        <CardHeader className="text-center space-y-2">
          <div className="text-5xl mb-2">🎯</div>
          <CardTitle className="text-2xl font-bold">AssisTT Quiz Time</CardTitle>
          <p className="text-sm text-muted-foreground">Sicil numaranızla giriş yapın</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sicil">Sicil Numarası</Label>
              <Input
                id="sicil"
                placeholder="Örn: A053252"
                value={sicil}
                onChange={(e) => setSicil(e.target.value.toUpperCase())}
                required
              />
            </div>
            {isAdmin && (
              <div className="space-y-2">
                <Label htmlFor="password">Şifre (Yönetici)</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Şifrenizi girin"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
            )}
            {error && (
              <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded p-2">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Giriş yapılıyor..." : "Giriş Yap"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
