import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowDownToLine, ArrowRight, Braces, ChevronDown, ChevronRight, CircleAlert,
  Code2, FileCode2, Flame, GitBranch, Globe2, Layers3, RefreshCw, Search, Trophy, Upload, Wallet, Zap,
} from 'lucide-react';
import { analyze, demo, readReport, type FunctionProfile, type Report } from './profile';
import { analyzeRealm, getLeaderboard, normalizeRealm, registry, submitProfile, type RegistryRow } from './onyx';
import './style.css';

type Tab = 'flame' | 'live' | 'leaderboard';
type Session = { report: Report; sources: Record<string, string>; name: string; realm?: string; kind: 'demo' | 'live' | 'import' };
const number = new Intl.NumberFormat('en-US');
const format = (n: number) => number.format(n);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const tabs = [
  { id: 'flame', name: 'FlameGraph & Call Tree', Icon: Flame },
  { id: 'live', name: 'Live Onyx Analyzer', Icon: Globe2 },
  { id: 'leaderboard', name: 'On-Chain Leaderboard', Icon: Trophy },
] as const;

function download(report: Report) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gasscope-report.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function App() {
  const [tab, setTab] = useState<Tab>('flame');
  const [session, setSession] = useState<Session>();
  const [request, setRequest] = useState('gno.land/r/gnoland/blog');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [leader, setLeader] = useState<{ rows: RegistryRow[]; render: string }>();
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [leaderError, setLeaderError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const [sendError, setSendError] = useState('');
  const [submitRealm, setSubmitRealm] = useState('');
  const upload = useRef<HTMLInputElement>(null);

  async function loadDemo() {
    setError('');
    setLoading(true);
    try {
      const report = await analyze(demo);
      setSession({ report, sources: demo, name: 'Tavern leaderboard', kind: 'demo' });
      setTab('flame');
    } catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadDemo(); }, []);

  useEffect(() => {
    if (tab !== 'leaderboard') return;
    let cancelled = false;
    setLeader(undefined);
    setLeaderError('');
    getLeaderboard(offset)
      .then(data => { if (!cancelled) setLeader(data); })
      .catch(error => { if (!cancelled) setLeaderError(errorText(error)); });
    return () => { cancelled = true; };
  }, [tab, offset, refresh]);

  async function runLive(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const realm = normalizeRealm(request);
      const result = await analyzeRealm(realm);
      setSession({ ...result, name: realm.split('/').at(-1)!, realm, kind: 'live' });
      setSubmitRealm(realm);
      setTab('flame');
    } catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }

  async function importReport(file: File) {
    setError('');
    setLoading(true);
    try {
      const report = readReport(await file.text());
      setSession({ report, sources: {}, name: file.name, kind: 'import' });
      setSubmitRealm('');
      setTab('flame');
    } catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }

  async function broadcast(event: React.FormEvent) {
    event.preventDefault();
    if (!session || session.kind === 'demo') return;
    setSending(true);
    setSent('');
    setSendError('');
    try {
      setSent(await submitProfile(session.realm ?? normalizeRealm(submitRealm), session.report));
      setOffset(0);
      setRefresh(value => value + 1);
    } catch (error) { setSendError(errorText(error)); }
    finally { setSending(false); }
  }

  function switchTab(next: Tab) { setError(''); setTab(next); }

  return <>
    <header className="header">
      <div className="shell header-inner">
        <button className="brand" onClick={() => switchTab('flame')} aria-label="GasScope profiler">
          <span className="brand-icon"><Activity size={23} strokeWidth={2.4}/></span>
          <span>Gas<span className="cyan">Scope</span><small>REALM PROFILER</small></span>
        </button>
        <div className="header-actions">
          <span className="network"><i/> Onyx <span className="muted">/</span> onyx-1</span>
          <button className="button" onClick={() => upload.current?.click()} disabled={loading}><Upload size={15}/> Import report</button>
          <input type="file" accept=".json,application/json" hidden ref={upload} onChange={event => {
            const file = event.currentTarget.files?.[0];
            if (file) void importReport(file);
            event.currentTarget.value = '';
          }}/>
        </div>
      </div>
    </header>
    <main className="shell">
      <div className="page-heading">
        <div>
          <div className="breadcrumb"><Layers3 size={13}/> GasScope <ChevronRight size={13}/> {tab === 'flame' ? 'Profiler' : tabs.find(item => item.id === tab)?.name}</div>
          <h1>{tab === 'flame' ? 'Realm profiler' : tab === 'live' ? 'Live Onyx analyzer' : 'On-chain leaderboard'}</h1>
          <p>{tab === 'flame' ? 'Inspect estimated gas, call paths, and allocation hotspots in Gno realms.'
            : tab === 'live' ? 'Fetch public realm source from Onyx and analyze it in your browser.'
            : 'Browse submitted profiles and publish your analysis to Onyx.'}</p>
        </div>
        {tab === 'flame' && session && <button className="button export" onClick={() => download(session.report)}><ArrowDownToLine size={16}/> Export JSON</button>}
      </div>
      <nav className="navigation" aria-label="GasScope views">
        {tabs.map(({ id, name, Icon }) => <button key={id} onClick={() => switchTab(id)} aria-current={tab === id ? 'page' : undefined}><Icon size={16}/>{name}</button>)}
      </nav>
      {error && <div className="notice error" role="alert"><CircleAlert size={17}/>{error}</div>}
      {tab === 'flame' && (session
        ? <Profiler key={session.name + session.kind} session={session}/>
        : loading && <div className="notice" role="status">Loading the demo profile…</div>)}
      {tab === 'live' && <section className="panel live-panel">
        <div className="panel-heading"><span className="panel-icon"><Globe2 size={19}/></span><div><h2>Analyze a realm</h2><p>Source is read directly from Onyx using <code>vm/qfile</code>.</p></div></div>
        <form onSubmit={runLive}>
          <label htmlFor="realm">Realm path</label>
          <div className="field-row"><input id="realm" value={request} onChange={event => setRequest(event.target.value)} required/>
            <button className="button primary" disabled={loading}><Zap size={16}/>{loading ? 'Analyzing…' : 'Analyze realm'}</button></div>
        </form>
        <div className="demo-action"><span>Explore the profiler with a bundled sample realm.</span>
          <button className="button" disabled={loading} onClick={() => void loadDemo()}>Load demo <ArrowRight size={15}/></button></div>
      </section>}
      {tab === 'leaderboard' && <div className="leader-layout">
        <section className="panel live-panel">
          <div className="panel-heading"><span className="panel-icon"><Trophy size={18}/></span><div><h2>Registry submissions</h2><p><code>{registry}</code></p></div>
            <button className="button refresh" aria-label="Refresh registry" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={16}/></button></div>
          {leaderError ? <div className="notice error" role="alert">{leaderError}</div> : !leader ? <p role="status">Loading registry…</p> :
            <>
              {leader.rows.length === 0 ? <p>No submissions on this page.</p> : <div className="table-scroll"><table>
                <thead><tr><th>ID / Realm</th><th>Gas points</th><th>Hotspots</th><th>Attestation</th></tr></thead>
                <tbody>{leader.rows.map(row => <tr key={row.id}><td><code title={row.owner}>#{row.id} {row.realmPath}</code><small>{row.topRule}</small></td>
                  <td>{format(row.totalGas)}</td><td>{row.hotspotsCount}</td><td>{row.verified ? 'Attested' : 'Pending'}</td></tr>)}</tbody>
              </table></div>}
              {leader.rows.length > 0 && <RegistryChart rows={leader.rows}/>}
              <details className="raw-render"><summary>Realm Render() output</summary><pre>{leader.render}</pre></details>
              <div className="pagination"><button className="button" disabled={!offset} onClick={() => setOffset(n => n - 20)}>Previous</button>
                <button className="button" disabled={leader.rows.length < 20} onClick={() => setOffset(n => n + 20)}>Next</button></div>
            </>}
        </section>
        <section className="panel live-panel">
          <div className="panel-heading"><span className="panel-icon"><Wallet size={18}/></span><div><h2>Publish profile</h2><p>Sign your submission with Adena.</p></div></div>
          {session && session.kind !== 'demo' ? <form onSubmit={broadcast}>
            <label htmlFor="submit-realm">Realm path</label>
            <input id="submit-realm" value={session.realm ?? submitRealm} readOnly={Boolean(session.realm)} onChange={event => setSubmitRealm(event.target.value)} required placeholder="gno.land/r/namespace/realm"/>
            <button className="button primary publish" disabled={sending}><Wallet size={16}/>{sending ? 'Waiting for Adena…' : 'Submit with Adena'}</button>
          </form> : <p>Analyze a live realm or import a CLI report to publish a profile.</p>}
          {sent && <p className="notice" role="status">Submitted · {sent}</p>}
          {sendError && <p className="notice error" role="alert">{sendError}</p>}
        </section>
      </div>}
      <footer><span><Activity size={14}/> GasScope</span><span>Static estimates · Onyx testnet</span></footer>
    </main>
  </>;
}

function RegistryChart({ rows }: { rows: RegistryRow[] }) {
  const max = Math.max(1, ...rows.map(row => row.totalGas));
  return <div className="registry-chart">
    <h3>Estimated gas distribution</h3>
    {rows.map(row => <div className="registry-bar" key={row.id}>
      <span>#{row.id}</span><span className="registry-track"><span className="bar normal" style={{ width: row.totalGas / max * 100 + '%' }}/></span><span>{format(row.totalGas)}</span>
    </div>)}
  </div>;
}

function Profiler({ session }: { session: Session }) {
  const { report, sources } = session;
  const sorted = [...report.functions].sort((a, b) => b.estimatedGas - a.estimatedGas);
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'gas' | 'tree'>('gas');
  const active = sorted.find(f => f.id === selected) ?? sorted[0];
  const totalHotspots = sorted.reduce((sum, f) => sum + f.hotspots.length, 0);
  const crossings = sorted.reduce((sum, f) => sum + f.calls.filter(c => c.crossRealm).length, 0);
  const max = Math.max(1, sorted[0]?.estimatedGas ?? 0);
  const filtered = sorted.filter(f => (f.id + ' ' + f.name).toLowerCase().includes(search.trim().toLowerCase()));
  const metrics = [
    { label: 'Estimated gas', value: report.totalGas, Icon: Zap, tone: 'cyan', detail: 'Static gas points' },
    { label: 'Functions', value: sorted.length, Icon: Braces, tone: 'cyan', detail: 'Exported and internal' },
    { label: 'Hotspots', value: totalHotspots, Icon: Flame, tone: 'orange', detail: 'Across six rules' },
    { label: 'Realm crossings', value: crossings, Icon: GitBranch, tone: 'violet', detail: 'Static call sites' },
  ];
  return <>
    <div className="session">
      <span className="session-icon"><FileCode2 size={17}/></span>
      <strong>{session.name}</strong><span className="tag">{session.kind === 'demo' ? 'DEMO MODE' : session.kind === 'live' ? 'ONYX SOURCE' : 'IMPORTED REPORT'}</span>
      <span className="session-path">{session.realm ?? (session.kind === 'demo' ? 'tavern/leaderboard.gno' : report.mode + ' analysis')}</span>
    </div>
    <div className="metrics">
      {metrics.map(({ label, value, Icon, tone, detail }) => <div className="metric panel" key={label}>
        <div className="metric-label"><span>{label}</span><Icon size={17} className={tone}/></div>
        <strong>{format(value)}</strong><p>{detail}</p>
      </div>)}
    </div>
    <div className="profile-grid">
      <section className="panel chart">
        <div className="chart-heading"><div><h2><Flame size={18} className="orange"/> Function footprint</h2><p>Estimated gas points by function</p></div>
          <div className="segmented"><button className={view === 'gas' ? 'chosen' : ''} onClick={() => setView('gas')}><Activity size={14}/> FlameGraph</button>
            <button className={view === 'tree' ? 'chosen' : ''} onClick={() => setView('tree')}><GitBranch size={14}/> Call tree</button></div></div>
        <div className="chart-tools">
          <label className="search"><Search size={15}/><input aria-label="Filter functions" placeholder="Filter functions…" value={search} onChange={event => setSearch(event.target.value)}/></label>
          <div className="legend"><span><i className="normal"/> Baseline</span><span><i className="hot"/> Hotspot</span></div>
        </div>
        {view === 'gas' ? <div className="plot">
          <div className="graph-axis"><span>FUNCTION</span><div>{[0, .25, .5, .75, 1].map(n => <span key={n}>{format(Math.round(max * n))}</span>)}</div><span>POINTS</span></div>
          {filtered.map(f => <button title={f.id} key={f.id} className={'graph-row ' + (active?.id === f.id ? 'selected' : '')} onClick={() => setSelected(f.id)}>
            <span className="graph-label"><ChevronRight size={13}/>{f.name}</span>
            <span className="track"><span className={f.hotspots.length ? 'bar hot' : 'bar normal'} style={{ width: Math.max(1, f.estimatedGas / max * 100) + '%' }}/></span>
            <span className="score">{format(f.estimatedGas)}</span>
          </button>)}
        </div> : <div className="tree">
          {filtered.map(fn => <Tree key={fn.id} fn={fn} all={sorted} ancestors={[]} onSelect={setSelected}/>)}
        </div>}
        {filtered.length === 0 && <p className="empty">No matching functions.</p>}
        <div className="chart-footer">{filtered.length} of {sorted.length} functions <span>Select a function to inspect its source and rules.</span></div>
      </section>
      <aside className="panel inspector">
        <div className="inspector-heading"><Code2 size={18} className="cyan"/><h2>Function inspector</h2></div>
        {active ? <Inspector fn={active} source={sources[active.file]} total={report.totalGas}/> : <p className="empty">No functions in this report.</p>}
      </aside>
    </div>
    {report.note && <p className="notice">{report.note}</p>}
    {Array.isArray(report.tests) && report.tests.length > 0 && <section className="panel test-results">
      <h2>Gno test measurements</h2>
      {report.tests.map(run => <details key={run.package}><summary>{run.package} · {run.passed ? 'Passed' : 'Failed'}</summary>
        <table><thead><tr><th>Test</th><th>Elapsed (ms)</th><th>VM gas</th></tr></thead>
          <tbody>{Object.entries(run.timingMs ?? {}).map(([name, ms]) => <tr key={name}><td>{name}</td><td>{ms}</td><td>{run.gasUsed?.[name] ?? '—'}</td></tr>)}</tbody></table>
      </details>)}
    </section>}
  </>;
}

function Tree({ fn, all, ancestors, onSelect }: { fn: FunctionProfile; all: FunctionProfile[]; ancestors: string[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const cycle = ancestors.includes(fn.id);
  return <div className="tree-node">
    <div className="tree-head">
      <button className="tree-expand" aria-label={open ? 'Collapse ' + fn.name : 'Expand ' + fn.name} aria-expanded={open} disabled={cycle || !fn.calls.length} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
      <button className="tree-name" onClick={() => onSelect(fn.id)}>{fn.name}</button>
      <span>{cycle ? 'recursive' : fn.calls.length + ' calls'}</span>
    </div>
    {open && !cycle && <div className="tree-children">{fn.calls.map((call, i) => {
      const target = all.find(f => f.id === call.target);
      return target && !call.crossRealm
        ? <Tree key={i} fn={target} all={all} ancestors={[...ancestors, fn.id]} onSelect={onSelect}/>
        : <div className="tree-leaf" key={i}><span className={call.crossRealm ? 'violet' : ''}>{call.target}</span><small>{call.crossRealm ? 'realm crossing · ' : ''}L{call.line}</small></div>;
    })}</div>}
  </div>;
}

function Inspector({ fn, source, total }: { fn: FunctionProfile; source?: string; total: number }) {
  const lines = source?.split(/\r?\n/);
  return <div className="inspector-body">
    <h3>{fn.name}<span>()</span></h3>
    <div className="source-location"><FileCode2 size={14}/><span title={fn.file}>{fn.file.split('/').at(-1)}:{fn.line}</span><span className="visibility">{fn.exported ? 'exported' : 'internal'}</span></div>
    <div className="function-stats"><span><strong>{format(fn.estimatedGas)}</strong> gas points</span><span><strong>{total ? (fn.estimatedGas / total * 100).toFixed(1) : '0'}%</strong> of profile</span></div>
    <div className="section-label">HOTSPOTS <span>{fn.hotspots.length}</span></div>
    {fn.hotspots.length === 0 && <p className="muted">No hotspot rules triggered.</p>}
    {fn.hotspots.map((h, index) => <details className="rule" key={h.rule + h.line} open={index === 0 || undefined}>
      <summary><CircleAlert size={15}/><code>{h.rule}</code><span>L{h.line}</span><ChevronDown size={14}/></summary>
      <div className="rule-body">
        <p>{h.suggestion}</p><div className="risk"><span>{h.allocRisk} allocation risk</span><span>+{h.estimatedGas} pts</span></div>
        <div className="snippet"><span>BEFORE{lines ? ' · L' + h.line : ' · EXAMPLE'}</span><pre>{lines?.[h.line - 1]?.trim() ?? h.before}</pre></div>
        <div className="snippet after"><span>AFTER · PATTERN</span><pre>{h.after}</pre></div>
      </div>
    </details>)}
    {lines && <details className="source-preview"><summary>View source at line {fn.line}</summary>
      <pre>{lines.slice(fn.line - 1, fn.line + 7).map((line, index) => (fn.line + index) + '  ' + line).join('\n')}</pre></details>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
