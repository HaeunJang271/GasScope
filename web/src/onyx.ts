import { analyze, type Report } from './profile';

const rpc = import.meta.env.VITE_ONYX_RPC || 'https://rpc.onyx.testnets.gno.land';
export const registry = import.meta.env.VITE_REGISTRY_PATH || 'gno.land/r/g1832jd5gytypzj48d0328r2sqvv2x38zj0zryuq/gasscope_reg';
const chain = 'onyx-1';
const realmPattern = /^gno\.land\/r\/[a-z0-9_]+(?:\/[a-z0-9_]+)+$/;

class PackageUnavailableError extends Error {}

export function normalizeRealm(input: string): string {
  let realm = input.trim().replace(/^https?:\/\//, '').replace(/^onyx\.testnets\.gno\.land\//, 'gno.land/').replace(/\/$/, '');
  if (realm.startsWith('r/')) realm = 'gno.land/' + realm;
  if (realm.startsWith('/r/')) realm = 'gno.land' + realm;
  if (!realmPattern.test(realm)) throw new Error('Enter a full realm path, for example gno.land/r/gnoland/blog.');
  return realm;
}

async function query(path: string, input: string): Promise<string> {
  const data = Array.from(new TextEncoder().encode(input), byte => byte.toString(16).padStart(2, '0')).join('');
  const params = new URLSearchParams({ path: JSON.stringify(path), data: '0x' + data });
  const response = await fetch(rpc.replace(/\/$/, '') + '/abci_query?' + params, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Onyx RPC returned HTTP ' + response.status + '.');
  const body = await response.json();
  const responseData = body.result?.response ?? body.result?.Response;
  const result = responseData?.ResponseBase ?? responseData;
  if (!result || body.error || result.error || result.Error || Number(result.code ?? result.Code ?? 0)) {
    const details = JSON.stringify([body.error, result?.error, result?.Error, result?.log, result?.Log]);
    if (/\b(?:InvalidPkgPathError|InvalidPackageError|package not found|package "[^"]+" is not available)\b/i.test(details.replaceAll('\\"', '"'))) {
      throw new PackageUnavailableError('Realm package is unavailable on Onyx.');
    }
    throw new Error(result?.log || result?.Log || result?.error?.message || body.error?.message || 'Onyx query failed.');
  }
  const encoded = result.data ?? result.Data ?? result.value ?? result.Value;
  if (typeof encoded !== 'string') throw new Error('Onyx returned no query data.');
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
}

export async function analyzeRealm(realm: string) {
  const listing = await query('vm/qfile', realm);
  const names = listing.split(/\r?\n/).map(s => s.trim()).filter(s => /^[\w.-]+\.gno$/.test(s) && !s.endsWith('_test.gno') && !s.endsWith('_filetest.gno'));
  if (!names.length) throw new Error('No production .gno files found in this realm.');
  const sources: Record<string, string> = {};
  for (let start = 0; start < names.length; start += 8) {
    await Promise.all(names.slice(start, start + 8).map(async name => {
      const path = realm + '/' + name;
      sources[path] = await query('vm/qfile', path);
    }));
  }
  return { report: await analyze(sources), sources };
}

export interface RegistryRow {
  id: number; realmPath: string; totalGas: number; hotspotsCount: number;
  topRule: string; owner: string; verified: boolean;
}
export type Leaderboard =
  | { kind: 'live'; rows: RegistryRow[]; render: string }
  | { kind: 'preview'; rows: RegistryRow[] };

const previewRows: RegistryRow[] = [
  { id: 3, realmPath: 'gno.land/r/demo/tavern_scores', totalGas: 820, hotspotsCount: 6, topRule: 'CROSS_REALM_IN_LOOP', owner: '', verified: false },
  { id: 2, realmPath: 'gno.land/r/demo/market', totalGas: 540, hotspotsCount: 4, topRule: 'UNBOUNDED_AVL_ITER', owner: '', verified: false },
  { id: 1, realmPath: 'gno.land/r/demo/journal', totalGas: 290, hotspotsCount: 2, topRule: 'LOOP_STRING_CONCAT', owner: '', verified: false },
];

export async function getLeaderboard(offset: number): Promise<Leaderboard> {
  const path = normalizeRealm(registry);
  try {
    const list = await query('vm/qrender', path + ':profiles/' + offset);
    const rows: RegistryRow[] = JSON.parse(list);
    if (!Array.isArray(rows)) throw new Error('Unexpected registry response.');
    const render = await query('vm/qrender', path + ':' + offset);
    return { kind: 'live', rows, render };
  } catch (error) {
    if (error instanceof PackageUnavailableError) return { kind: 'preview', rows: previewRows };
    throw error;
  }
}

type WalletReply<T> = { code: number; type: string; message: string; data: T };
interface Adena {
  AddEstablish(name: string): Promise<WalletReply<unknown>>;
  GetAccount(): Promise<WalletReply<{ address: string; chainId?: string }>>;
  SwitchNetwork(chainId: string): Promise<WalletReply<{ chainId: string }>>;
  DoContract(tx: { messages: { type: string; value: object }[]; memo: string }): Promise<WalletReply<{ hash?: string }>>;
}
declare global { interface Window { adena?: Adena } }

export async function submitProfile(realm: string, report: Report): Promise<string> {
  const destination = normalizeRealm(registry);
  const hotspots = report.functions.flatMap(f => f.hotspots);
  const top = hotspots.reduce<(typeof hotspots)[number] | undefined>((best, h) =>
    !best || h.estimatedGas > best.estimatedGas ? h : best, undefined);
  const encoder = new TextEncoder();
  let json = JSON.stringify(report);
  if (encoder.encode(json).length > 32000) {
    const compact = {
      totalGas: report.totalGas,
      mode: report.mode,
      tests: report.tests,
      functions: report.functions.map(f => ({
        id: f.id,
        name: f.name,
        file: f.file,
        line: f.line,
        estimatedGas: f.estimatedGas,
        crossRealmCalls: f.calls.filter(call => call.crossRealm).length,
        hotspots: f.hotspots.map(h => ({
          rule: h.rule,
          line: h.line,
          estimatedGas: h.estimatedGas,
          message: h.suggestion,
          fix: h.after,
          snippet: h.before.slice(0, 120),
        })),
      })),
    };
    json = JSON.stringify(compact);
    if (encoder.encode(json).length > 32000) {
      json = JSON.stringify({
        ...compact,
        functions: compact.functions.map(f => ({
          ...f,
          hotspots: f.hotspots.map(({ snippet, ...hotspot }) => hotspot),
        })),
      });
    }
    if (encoder.encode(json).length > 32768) {
      throw new Error('This report exceeds the registry’s 32 KiB limit.');
    }
  }
  const wallet = window.adena;
  if (!wallet) throw new Error('Install the Adena browser extension to submit a profile.');
  const connection = await wallet.AddEstablish('GasScope');
  if (connection.code && connection.type !== 'ALREADY_CONNECTED') throw new Error(connection.message);
  let account = await wallet.GetAccount();
  if (account.code) throw new Error(account.message);
  if (account.data?.chainId !== chain) {
    const network = await wallet.SwitchNetwork(chain);
    if (network.code || network.data?.chainId !== chain) throw new Error(network.message || 'Switch Adena to Onyx (onyx-1).');
    account = await wallet.GetAccount();
  }
  if (account.code || !account.data?.address || account.data.chainId !== chain) {
    throw new Error(account.message || 'No Onyx account available.');
  }
  const response = await wallet.DoContract({
    messages: [{ type: '/vm.m_call', value: {
      caller: account.data.address, send: '', pkg_path: destination, func: 'SubmitProfile',
      args: [normalizeRealm(realm), String(report.totalGas), String(hotspots.length), top?.rule ?? '', json],
    } }],
    memo: 'GasScope profile',
  });
  if (response.code) throw new Error(response.message);
  return response.data?.hash ?? 'Broadcast accepted';
}

