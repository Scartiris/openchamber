import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';

type MemoryRow = { id: string; memory: string; score?: number; agent_id?: string; createdAt?: string };
type KbDoc = { id: string; file: string; status: string; createdAt?: string };
type MeshNode = { nodeId: string; hostname: string; online?: boolean; displayName?: string; lastSeenAt?: string; lastInputAt?: string };
type MeshStatus = { nodes?: MeshNode[]; activeNodeId?: string; lastCheckAt?: number };
type ChannelCfg = { mode: string; base?: string; key?: string; model?: string; keyMasked?: string };
type Channels = Record<'mem' | 'arb' | 'kb', ChannelCfg>;

const SIDE = '/api/pigeon';

async function sideFetch(path: string, method = 'GET', body?: object): Promise<any> {
  const response = await runtimeFetch(`${SIDE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

const fmtTime = (v: unknown) => {
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(n)) return '';
  return new Date(n).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const CHANNEL_META: Record<'mem' | 'arb' | 'kb', { label: string; gateway: boolean; hint: string }> = {
  mem: { label: '记忆抽取', gateway: false, hint: 'mem0 需要 OpenAI 兼容 API，不支持对话网关' },
  arb: { label: '记忆仲裁（纠错）', gateway: true, hint: '网关模式=复用对话已登录的模型凭据' },
  kb: { label: '知识库整理', gateway: true, hint: '导入速度主要取决于此通道' },
};

const PRESETS: Record<string, { base: string; models: string[] }> = {
  'https://api.siliconflow.cn/v1': { base: 'https://api.siliconflow.cn/v1', models: ['Qwen/Qwen3-8B', 'Qwen/Qwen3-32B', 'THUDM/GLM-4-9B'] },
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1': { base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', models: ['qwen-flash', 'qwen-turbo', 'qwen-plus'] },
  'https://api.cerebras.ai/v1': { base: 'https://api.cerebras.ai/v1', models: ['qwen-3-32b', 'llama-4-scout-17b-16e-instruct'] },
  'https://open.bigmodel.cn/api/paas/v4': { base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7-flash', 'glm-4.5-flash'] },
  'https://openrouter.ai/api/v1': { base: 'https://openrouter.ai/api/v1', models: ['nvidia/nemotron-3-super-120b-a12b:free'] },
};

function ModelChannelSection(): JSX.Element {
  const [channels, setChannels] = React.useState<Channels | null>(null);
  const [providers, setProviders] = React.useState<any[]>([]);
  const [form, setForm] = React.useState<Record<string, ChannelCfg>>({});
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, string>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const payload = await sideFetch('/config/llm');
      setChannels(payload.channels || {});
      setProviders(payload.gatewayProviders || []);
      setForm(JSON.parse(JSON.stringify(payload.channels || {})));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载模型通道失败');
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const setF = (id: string, patch: Partial<ChannelCfg>) => {
    setForm((cur) => ({ ...cur, [id]: { ...(cur[id] || {}), ...patch } }));
  };

  const save = async (id: 'mem' | 'arb' | 'kb') => {
    setBusyId(id);
    try {
      const f = form[id] || ({} as ChannelCfg);
      const payload = await sideFetch('/config/llm', 'PUT', {
        [id]: { mode: f.mode, base: f.base || undefined, key: f.key || undefined, model: f.model || undefined },
      });
      setChannels(payload.channels || {});
      setForm(JSON.parse(JSON.stringify(payload.channels || {})));
      toast.success('已保存，立即生效');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally { setBusyId(null); }
  };

  const test = async (id: 'mem' | 'arb' | 'kb') => {
    setBusyId(id);
    setTestResult((cur) => ({ ...cur, [id]: '测试中…' }));
    const f = form[id] || ({} as ChannelCfg);
    try {
      const payload = await sideFetch('/config/llm/test', 'POST', {
        channel: id, mode: f.mode, base: f.base, key: f.key, model: f.model,
      });
      setTestResult((cur) => ({ ...cur, [id]: payload.ok ? `✓ ${payload.latencyMs}ms「${payload.sample}」` : `✗ ${payload.error}` }));
    } catch (error) {
      setTestResult((cur) => ({ ...cur, [id]: `✗ ${error instanceof Error ? error.message : '失败'}` }));
    } finally { setBusyId(null); }
  };

  return (
    <section className="space-y-3 px-2 pb-6" data-settings-item="pigeon.models">
      <h3 className="typography-ui-header font-medium text-foreground">模型通道</h3>
      <p className="px-1 text-[10px] text-muted-foreground">内置=默认免费线路；自定义=填 API 地址与密钥；对话网关=借用小鸽当前登录的模型凭据（仅仲裁/知识库支持）。</p>
      <div className="space-y-2">
        {(Object.keys(CHANNEL_META) as Array<keyof typeof CHANNEL_META>).map((id) => {
          const meta = CHANNEL_META[id];
          const cur = channels?.[id];
          const f = form[id] || ({} as ChannelCfg);
          const isOpen = openId === id;
          return (
            <div key={id} className="rounded-md border px-2 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{meta.label}</span>
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {cur ? (cur.mode === 'gateway' ? `网关 ${cur.model || '跟随设置'}` : cur.mode === 'custom' ? `自定义 ${cur.model || ''}` : '内置线路') : '…'}
                </span>
                {cur?.keyMasked && <span className="text-[10px] text-muted-foreground">{cur.keyMasked}</span>}
                <div className="ml-auto flex gap-1">
                  <Button size="xs" variant="outline" onClick={() => setOpenId(isOpen ? null : id)}>{isOpen ? '收起' : '配置'}</Button>
                  {isOpen && <Button size="xs" variant="outline" disabled={busyId === id} onClick={() => void test(id)}>测试</Button>}
                  {isOpen && <Button size="xs" disabled={busyId === id} onClick={() => void save(id)}>保存</Button>}
                </div>
              </div>
              {isOpen && (
                <div className="mt-2 space-y-2 border-t pt-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted-foreground">模式</span>
                    <select className="h-7 rounded-md border bg-transparent text-xs" value={f.mode || 'builtin'}
                      onChange={(e) => setF(id, { mode: e.target.value })}>
                      <option value="builtin">内置线路</option>
                      <option value="custom">自定义 API</option>
                      {meta.gateway && <option value="gateway">对话网关</option>}
                    </select>
                  </div>
                  {f.mode === 'custom' && (
                    <>
                      <Input className="h-7 text-xs" placeholder="API 地址（OpenAI 兼容，如 https://api.siliconflow.cn/v1）"
                        value={f.base || ''} onChange={(e) => setF(id, { base: e.target.value })} />
                      <div className="flex flex-wrap gap-2">
                        <Input className="h-7 flex-1 min-w-40 text-xs" type="password" placeholder={`密钥（${cur?.keyMasked || '未配置'}，留空保持不变）`}
                          value={f.key || ''} onChange={(e) => setF(id, { key: e.target.value })} />
                        <Input className="h-7 flex-1 min-w-40 text-xs" placeholder="模型名" list={`models-${id}`}
                          value={f.model || ''} onChange={(e) => setF(id, { model: e.target.value })} />
                        <datalist id={`models-${id}`}>
                          {Object.entries(PRESETS).flatMap(([base, p]) =>
                            base === (f.base || '') ? p.models.map((m) => <option key={m} value={m} />) : [])}
                        </datalist>
                      </div>
                      <p className="text-[10px] text-muted-foreground">常用地址：{Object.keys(PRESETS).join(' · ')}</p>
                    </>
                  )}
                  {f.mode === 'gateway' && (
                    <div className="space-y-1">
                      <Input className="h-7 text-xs" placeholder={`模型引用（${'providerID/modelID'}，留空跟随小模型设置）`}
                        value={f.model || ''} onChange={(e) => setF(id, { model: e.target.value })} />
                      <p className="text-[10px] text-muted-foreground">
                        已认证对话渠道：{providers.length ? providers.map((p: any) => p.id || p.name || String(p)).join('、') : '读取中…'}
                      </p>
                    </div>
                  )}
                  {testResult[id] && <p className="text-[10px]">{testResult[id]}</p>}
                  <p className="text-[10px] text-muted-foreground">{meta.hint}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export const PigeonPage: React.FC = () => {
  // ---------- 长期记忆 ----------
  const [query, setQuery] = React.useState('');
  const [domain, setDomain] = React.useState('');
  const [rows, setRows] = React.useState<MemoryRow[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editText, setEditText] = React.useState('');

  const loadMemories = React.useCallback(async (q = '', dom = '') => {
    setBusy(true);
    try {
      if (q.trim()) {
        const payload = await sideFetch('/memory/search', 'POST', { query: q, agent_id: dom || undefined, limit: 10 });
        setRows(payload?.results?.results || []);
      } else {
        const payload = await sideFetch(`/memory/list?agent_id=${dom || ''}`);
        setRows(payload.results || []);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载失败');
    } finally { setBusy(false); }
  }, []);

  React.useEffect(() => { void loadMemories(); }, [loadMemories]);

  const saveEdit = async (id: string) => {
    try {
      await sideFetch('/memory/update', 'POST', { id, text: editText });
      setRows((cur) => cur.map((r) => (r.id === id ? { ...r, memory: editText } : r)));
      setEditingId(null);
      toast.success('已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    }
  };

  const deleteMemory = async (id: string) => {
    try {
      await sideFetch('/memory/delete', 'POST', { id });
      setRows((cur) => cur.filter((r) => r.id !== id));
      toast.success('已删除');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  // ---------- 知识库 ----------
  const [kbQuery, setKbQuery] = React.useState('');
  const [kbAnswer, setKbAnswer] = React.useState('');
  const [kbDocs, setKbDocs] = React.useState<KbDoc[]>([]);
  const [kbText, setKbText] = React.useState('');
  const [kbTitle, setKbTitle] = React.useState('');
  const [kbBusy, setKbBusy] = React.useState(false);

  const loadKbDocs = React.useCallback(async () => {
    try {
      const payload = await sideFetch('/kb/docs');
      setKbDocs(payload.documents || []);
    } catch { /* 首次无索引时可忽略 */ }
  }, []);

  React.useEffect(() => { void loadKbDocs(); }, [loadKbDocs]);

  const kbAsk = async () => {
    setKbBusy(true);
    try {
      const payload = await sideFetch('/kb/query', 'POST', { query: kbQuery, mode: 'naive' });
      setKbAnswer(String(payload.answer ?? '(无结果)'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '查询失败');
    } finally { setKbBusy(false); }
  };

  const kbIngest = async () => {
    if (!kbText.trim()) return;
    setKbBusy(true);
    try {
      await sideFetch('/kb/ingest', 'POST', { text: kbText, description: kbTitle || 'ui-upload' });
      setKbText(''); setKbTitle('');
      toast.success('已导入（图谱构建约需1分钟）');
      setTimeout(() => { void loadKbDocs(); }, 60_000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败');
    } finally { setKbBusy(false); }
  };

  const kbDelete = async (id: string) => {
    try {
      await sideFetch('/kb/delete', 'POST', { docId: id });
      toast.success('已删除');
      void loadKbDocs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败');
    }
  };

  // ---------- 多端设备（node-mesh） ----------
  const [mesh, setMesh] = React.useState<MeshStatus | null>(null);
  const [meshErr, setMeshErr] = React.useState('');

  const loadMesh = React.useCallback(async () => {
    try {
      const response = await runtimeFetch('/api/mesh/status');
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || `HTTP ${response.status}`);
      setMesh(payload); setMeshErr('');
    } catch (error) {
      setMeshErr(error instanceof Error ? error.message : '加载失败');
    }
  }, []);

  React.useEffect(() => {
    void loadMesh();
    const timer = window.setInterval(() => { void loadMesh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadMesh]);

  const triggerCheck = async () => {
    try {
      await runtimeFetch('/api/mesh/monitor/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      toast.success('已触发检查');
      setTimeout(() => { void loadMesh(); }, 3_000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '触发失败');
    }
  };

  return (
    <SettingsPageLayout title="记忆与知识库" showSaveStatus={false}>
      <ModelChannelSection />

      <section className="space-y-3 px-2 pb-6" data-settings-item="pigeon.mesh">
        <h3 className="typography-ui-header font-medium text-foreground">多端设备</h3>
        {meshErr && <p className="px-1 text-xs text-red-500">{meshErr}</p>}
        <div className="space-y-1">
          {(mesh?.nodes || []).map((node) => (
            <div key={node.nodeId} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
              <span className={`inline-block h-2 w-2 rounded-full ${node.online ? 'bg-green-500' : 'bg-zinc-400'}`} />
              <span className="font-medium">{node.hostname}</span>
              {node.displayName && <span className="text-muted-foreground">({node.displayName})</span>}
              {node.nodeId === mesh?.activeNodeId && <span className="rounded bg-blue-500/15 px-1 py-0.5 text-[10px] text-blue-500">当前活跃</span>}
              {!node.online && <span className="text-muted-foreground">离线</span>}
              <span className="ml-auto text-muted-foreground">{fmtTime(node.lastSeenAt || mesh?.lastCheckAt)}</span>
            </div>
          ))}
          {!mesh?.nodes?.length && !meshErr && <p className="px-1 text-xs text-muted-foreground">暂无设备接入。</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => void triggerCheck()}>触发检查</Button>
          <Button size="xs" variant="outline" onClick={() => void loadMesh()}>刷新</Button>
          <span className="text-[10px] text-muted-foreground">活跃设备自动跟随最近操作的机器 · 15s 自动刷新</span>
        </div>
      </section>

      <section className="space-y-3 px-2 pb-6" data-settings-item="pigeon.memory">
        <h3 className="typography-ui-header font-medium text-foreground">长期记忆（mem0）</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="h-7 flex-1 min-w-48" placeholder="搜索记忆（留空列出全部）…" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void loadMemories(query, domain); }} />
          <select className="h-7 rounded-md border bg-transparent text-xs"
            value={domain} onChange={(e) => { setDomain(e.target.value); void loadMemories(query, e.target.value); }}>
            <option value="">全部域</option>
            <option value="base">base</option>
            <option value="code">code</option>
            <option value="gongwen">gongwen</option>
          </select>
          <Button size="xs" disabled={busy} onClick={() => void loadMemories(query, domain)}>{query.trim() ? '搜索' : '刷新'}</Button>
        </div>
        <div className="max-h-96 space-y-1 overflow-auto">
          {rows.map((row) => (
            <div key={row.id} className="rounded-md border px-2 py-1.5">
              {editingId === row.id ? (
                <div className="space-y-1">
                  <textarea className="min-h-16 w-full rounded-md border bg-transparent p-2 text-xs" value={editText}
                    onChange={(e) => setEditText(e.target.value)} />
                  <div className="flex gap-2">
                    <Button size="xs" onClick={() => void saveEdit(row.id)}>保存</Button>
                    <Button size="xs" variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="flex-1 text-xs">
                    <span className="mr-2 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{row.agent_id || '-'}</span>
                    {row.memory}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="xs" variant="outline" onClick={() => { setEditingId(row.id); setEditText(row.memory); }}>改</Button>
                    <Button size="xs" variant="destructive" onClick={() => void deleteMemory(row.id)}>删</Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {!rows.length && <p className="px-1 text-xs text-muted-foreground">暂无记忆条目。</p>}
        </div>
      </section>

      <section className="space-y-3 px-2 pb-6" data-settings-item="pigeon.kb">
        <h3 className="typography-ui-header font-medium text-foreground">知识库（LightRAG）</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="h-7 flex-1 min-w-48" placeholder="语义检索知识库…" value={kbQuery}
            onChange={(e) => setKbQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void kbAsk(); }} />
          <Button size="xs" disabled={kbBusy} onClick={() => void kbAsk()}>查询</Button>
        </div>
        {kbAnswer && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border p-2 text-xs">{kbAnswer}</pre>}
        <div className="grid gap-2">
          <Input className="h-7" placeholder="标题（可选）" value={kbTitle} onChange={(e) => setKbTitle(e.target.value)} />
          <textarea className="min-h-20 rounded-md border bg-transparent p-2 text-xs" placeholder="粘贴文本导入知识库…"
            value={kbText} onChange={(e) => setKbText(e.target.value)} />
          <div><Button size="xs" disabled={kbBusy || !kbText.trim()} onClick={() => void kbIngest()}>导入知识库</Button></div>
        </div>
        <div className="space-y-1">
          {kbDocs.map((doc) => (
            <div key={doc.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
              <div className="flex-1 truncate">
                <span className={`mr-2 rounded px-1 py-0.5 text-[10px] ${doc.status === 'processed' ? 'bg-green-500/15' : 'bg-amber-500/15'}`}>{doc.status || '?'}</span>
                {doc.file || doc.id.slice(0, 18)}
              </div>
              <Button variant="destructive" size="xs" onClick={() => void kbDelete(doc.id)}>删</Button>
            </div>
          ))}
          {!kbDocs.length && <p className="px-1 text-xs text-muted-foreground">知识库暂无文档（源文件可放网盘，索引自动托管）。</p>}
        </div>
        <p className="px-1 text-[10px] text-muted-foreground">知识库文档如需修改内容：删除后重新导入（RAG 索引按文档管理）。</p>
      </section>
    </SettingsPageLayout>
  );
};
