'use client';
import { useState } from 'react';
import { AppTabs, type Tab } from '@/components/app-tabs';
import { Board } from '@/components/kanban/board';
import { ChatPanel } from '@/components/assistant/chat-panel';
import { PromptConfig } from '@/components/assistant/prompt-config';

export default function Home() {
  const [tab, setTab] = useState<Tab>('distribuicao');

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex items-center gap-4 bg-navy px-4 py-2.5">
        <div className="text-lg font-bold text-white [font-family:var(--font-display)]">
          Painel da Clínica
        </div>
        <AppTabs tab={tab} setTab={setTab} />
        <div className="ml-auto text-xs text-white/40">
          por <span className="font-semibold text-cyan">VERTECH</span>
        </div>
      </header>

      {tab === 'distribuicao' ? (
        <Board />
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          <PromptConfig />
          <ChatPanel />
        </div>
      )}
    </div>
  );
}
