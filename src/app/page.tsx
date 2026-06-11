'use client';
import { useState } from 'react';
import { AppTabs, type Tab } from '@/components/app-tabs';
import { Board } from '@/components/kanban/board';
import { ChatPanel } from '@/components/assistant/chat-panel';
import { PromptConfig } from '@/components/assistant/prompt-config';

export default function Home() {
  const [tab, setTab] = useState<Tab>('distribuicao');

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 bg-navy px-4 py-2.5 shadow-md sm:gap-4 sm:px-5 sm:py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan/15 text-cyan">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </div>
          <div className="text-base font-bold leading-none text-white [font-family:var(--font-display)] sm:text-lg">
            Clínica Cazule
          </div>
          <span className="hidden text-xs text-white/40 sm:inline">· por <span className="font-semibold text-cyan">VERTECH</span></span>
        </div>
        <div className="order-3 w-full overflow-x-auto sm:order-none sm:ml-1 sm:w-auto">
          <AppTabs tab={tab} setTab={setTab} />
        </div>
        <div className="ml-auto hidden items-center gap-1.5 rounded-full bg-white/[0.06] px-2.5 py-1 text-[10px] font-medium text-white/55 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          demonstração · dados fictícios
        </div>
      </header>

      {tab === 'distribuicao' ? (
        <Board />
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          <PromptConfig />
          <ChatPanel onGoToBoard={() => setTab('distribuicao')} />
        </div>
      )}
    </div>
  );
}
