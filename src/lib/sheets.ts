/**
 * Leitura da planilha "Cazule — Agenda" no Google Sheets via Service Account.
 * Auth: google-auth-library (JWT), escopo readonly. Cache em memória (TTL 60s)
 * pra não bater na API a cada turno. Tudo tolerante a falha: se não houver
 * credencial/ID, ou a API falhar, agendaContexto() devolve '' e a Camila segue
 * com o comportamento antigo (propor horário deixando a equipe confirmar).
 */
import { JWT } from 'google-auth-library';
import {
  parseAgenda,
  parseGrade,
  parsePsicologas,
  resumoDisponibilidade,
  type AgendaData,
} from './agenda-core';

const CACHE_TTL_MS = 60_000;
const ABAS = ['Psicólogas', 'Grade Semanal', 'Agenda'] as const;

interface Cache {
  at: number;
  data: AgendaData;
}
const g = globalThis as unknown as { __cazuleAgendaCache?: Cache };

function serviceAccount(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { client_email?: string; private_key?: string };
    if (!j.client_email || !j.private_key) return null;
    // env vars costumam escapar \n do private_key — normaliza
    return { client_email: j.client_email, private_key: j.private_key.replace(/\\n/g, '\n') };
  } catch (e) {
    console.error('[sheets] GOOGLE_SERVICE_ACCOUNT_JSON inválido', e);
    return null;
  }
}

/** Busca as 3 abas (batchGet) e monta o AgendaData. Lança em erro de rede/API. */
async function fetchAgendaData(): Promise<AgendaData | null> {
  const sa = serviceAccount();
  const id = process.env.AGENDA_SHEET_ID;
  if (!sa || !id) return null;

  if (g.__cazuleAgendaCache && Date.now() - g.__cazuleAgendaCache.at < CACHE_TTL_MS) {
    return g.__cazuleAgendaCache.data;
  }

  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error('sem access token da service account');

  const ranges = ABAS.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${ranges}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}`);
  const json = (await res.json()) as { valueRanges?: Array<{ values?: string[][] }> };
  const vr = json.valueRanges ?? [];

  const data: AgendaData = {
    psicologas: parsePsicologas(vr[0]?.values ?? []),
    grade: parseGrade(vr[1]?.values ?? []),
    agenda: parseAgenda(vr[2]?.values ?? []),
  };
  g.__cazuleAgendaCache = { at: Date.now(), data };
  return data;
}

/**
 * Bloco de agenda pra injetar no system prompt. NUNCA lança: em qualquer falha
 * (desconfigurado, rede, API), devolve '' e a Camila segue sem a agenda.
 */
export async function agendaContexto(): Promise<string> {
  try {
    const data = await fetchAgendaData();
    if (!data || data.psicologas.length === 0) return '';
    return resumoDisponibilidade(data, {});
  } catch (e) {
    console.error('[sheets] agendaContexto falhou — seguindo sem agenda', e);
    return '';
  }
}
