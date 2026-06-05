'use client';

export type Tab = 'distribuicao' | 'teste';

export function AppTabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'distribuicao', label: 'Distribuição' },
    { id: 'teste', label: 'Teste (assistente)' },
  ];
  return (
    <div className="flex gap-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === t.id ? 'bg-cyan text-navy' : 'text-white/70 hover:text-white'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
