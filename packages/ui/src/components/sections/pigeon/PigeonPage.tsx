import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';

type MemoryRow = { id: string; memory: string; score?: number; agent_id?: string };
type KbDoc = { id: string; file: string; status: string; createdAt?: string };

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

export const PigeonPage: React.FC = () => {
  const [query, setQuery] = React.useState('');
  const [domain, setDomain] = React.useState('');
  const [rows, setRows] = React.useState<MemoryRow[]>([]);
  const [busy, setBusy] = React.useState(false);

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

  const searchMemories = async () => {
    setBusy(true);
    try {
      const payload = await sideFetch('/memory/search', 'POST', {
        query, agent_id: domain || undefined, limit: 10,
      });
      setRows(payload?.results?.results || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '搜索失败');
    } finally { setBusy(false); }
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

  return (
    <SettingsPageLayout title="记忆与知识库" showSaveStatus={false}>
      <section className="space-y-3 px-2 pb-6" data-settings-item="pigeon.memory">
        <h3 className="typography-ui-header font-medium text-foreground">长期记忆（mem0）</h3>
        <div className="flex flex-wrap gap-2">
          <Input className="h-7 flex-1 min-w-48" placeholder="搜索记忆…" value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void searchMemories(); }} />
          <select className="h-7 rounded-md border bg-transparent text-xs"
            value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">全部域</option>
            <option value="base">base</option>
            <option value="code">code</option>
            <option value="gongwen">gongwen</option>
          </select>
          <Button size="xs" disabled={busy} onClick={() => void searchMemories()}>搜索</Button>
        </div>
        <div className="space-y-1">
          {rows.map((row) => (
            <div key={row.id} className="flex items-start gap-2 rounded-md border px-2 py-1.5">
              <div className="flex-1 text-xs">
                <span className="mr-2 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">{row.agent_id || '-'}</span>
                {row.memory}
              </div>
              <Button variant="destructive" size="xs" onClick={() => void deleteMemory(row.id)}>删</Button>
            </div>
          ))}
          {!rows.length && <p className="px-1 text-xs text-muted-foreground">输入关键词搜索长期记忆。</p>}
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
      </section>
    </SettingsPageLayout>
  );
};
