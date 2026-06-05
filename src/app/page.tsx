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
      <header className="flex items-center gap-4 bg-navy px-5 py-3 shadow-md">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan/15 text-cyan">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </div>
          <div className="text-lg font-bold leading-none text-white [font-family:var(--font-display)]">
            Painel da Clínica
          </div>
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
