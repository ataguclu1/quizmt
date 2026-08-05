import { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import { getQuestionSets, type QuestionSet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import HostGame from "@/components/HostGame";

export default function LimitedUserPage() {
  const { user, logout } = useAuth();
  const token = user!.token;
  const [qSets, setQSets] = useState<QuestionSet[]>([]);

  useEffect(() => {
    getQuestionSets(token).then(setQSets).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-violet-700 text-white px-6 py-4 flex justify-between items-center shadow">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🎯</span>
          <div>
            <h1 className="font-bold text-lg">AssisTT Quiz Time</h1>
            <p className="text-violet-200 text-sm">{user!.adSoyad}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={logout} className="text-white border-white hover:bg-violet-600">
          Çıkış
        </Button>
      </header>

      <div className="max-w-2xl mx-auto p-6">
        <HostGame questionSets={qSets} />
      </div>
    </div>
  );
}
