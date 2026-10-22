/**
 * 流水线阶段判定：Dev → Test → Release → Prod（→ Other）。
 *
 * 为什么需要它：
 * 一个会话里常常有 4–5 个功能并行，各自的 PR 停在不同的目标分支上。
 * 面板按「更新时间」平铺时，Dev 起步的、卡在 Test 的、等发版的混在一起，
 * 眼睛只能一行行读分支名去猜「这个功能走到哪一步了」。
 * 这里把「目标分支」翻译成有序阶段，列表就能按阶段排、按阶段分组——
 * 顺序本身就是进度。
 *
 * 判定优先级（后者只在前者判不出来时生效）：
 *   1. label（`stage:test` / `env:release` 这类团队约定）；
 *   2. baseRefName（PR 的目标分支 = 这个 PR 要去哪，最准）；
 *   3. headRefName（兜底：分支名本身带 dev/test/release 语义）。
 *
 * 注意：这里只做**语义映射**，不发明流程。仓库用 `feature/*` 直接进 main、
 * 没有 test/release 分支时，这些 PR 会落进 prod 或 other —— 不会假装有阶段。
 */

export type PipelineStageId = 'dev' | 'test' | 'release' | 'prod' | 'other';

export interface PipelineStage {
  id: PipelineStageId;
  /** 界面展示名（英文，遵循插件既有 UI 语言） */
  label: string;
  /** 中文名，给 tooltip / 文档用 */
  labelZh: string;
  /** 排序序号：越小越靠前（越接近开发侧） */
  order: number;
}

/** 有序阶段表：sort 与分组都从这里取序号，不在各处硬编码数字 */
export const PIPELINE_STAGES: PipelineStage[] = [
  { id: 'dev', label: 'Dev', labelZh: '开发', order: 10 },
  { id: 'test', label: 'Test', labelZh: '测试', order: 20 },
  { id: 'release', label: 'Release', labelZh: '发布', order: 30 },
  { id: 'prod', label: 'Prod', labelZh: '生产', order: 40 },
  { id: 'other', label: 'Other', labelZh: '未归类', order: 99 },
];

const STAGE_BY_ID: Record<string, PipelineStage> = PIPELINE_STAGES.reduce((acc, s) => {
  acc[s.id] = s;
  return acc;
}, {} as Record<string, PipelineStage>);

export function stageById(id: string): PipelineStage {
  return STAGE_BY_ID[String(id || '')] || STAGE_BY_ID.other;
}

/**
 * 分支名 → 阶段。
 *
 * 用「整段匹配」而不是 `indexOf`：`feature/dev-tools` 是开发分支上的功能分支，
 * 不是 Dev 阶段。规则里的前缀必须从首字符开始，并带分隔符（`-` `_` `/` `.`）
 * 或直接跟版本号，`release-notes-bot` 这种命名才不会被误判成发布分支。
 */
const BRANCH_RULES: Array<{ id: PipelineStageId; test: RegExp }> = [
  // 生产：最终落地分支
  { id: 'prod', test: /^(main|master|prod|production|stable|live|ga)$/ },
  // 发布：release、release/1.2、release-v1、release_2、pre-release/...
  { id: 'release', test: /^(pre)?release(([-_/.]v?\d[\w.-]*)|)$/ },
  // 测试：test / testing / qa / staging / uat / sit / preprod
  { id: 'test', test: /^(test|testing|qa|staging|stage|uat|sit|preprod|pre-prod|pre-production)([-_/].*)?$/ },
  // 开发：dev / develop / development / integration / trunk
  { id: 'dev', test: /^(dev|develop|development|integration|trunk)([-_/].*)?$/ },
];

export type StageMatchedBy = 'label' | 'base' | 'head' | 'none';

export interface ResolvedStage {
  id: PipelineStageId;
  label: string;
  labelZh: string;
  order: number;
  matchedBy: StageMatchedBy;
  /** 命中的原始值（分支名或 label），便于排错「为什么这个 PR 算 Test」 */
  matchedValue: string;
}

/**
 * 用户自定义的阶段分支名（cordis.yml 的 `pipelineStages`）。
 * 语义：**追加并优先于内置规则**——把 `uat` 写进 prod，`uat` 就归生产；
 * 内置规则仍兜底，不会被整体替换掉（避免用户漏写一个名字导致某段空掉）。
 */
export interface StageOverrides {
  dev?: string[];
  test?: string[];
  release?: string[];
  prod?: string[];
}

/** 匹配顺序：先 Prod 再 Release/Test/Dev，和内置规则一致——先命中者生效 */
const OVERRIDE_STAGE_ORDER: PipelineStageId[] = ['prod', 'release', 'test', 'dev'];

/** 用户输入会进 RegExp，必须转义：既防语法错误，也防 `(a+)+` 这类回溯炸弹 */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface StageRule {
  id: PipelineStageId;
  test: RegExp;
}

/**
 * 把配置里的分支名编成规则。
 * 每个名字按「前缀 + 可选分隔符后缀」匹配（`uat` 命中 `uat` 与 `uat/1.2`），
 * 这样用户不必为每个变体写一条。
 */
export function buildStageOverrideRules(overrides?: StageOverrides | null): StageRule[] {
  const out: StageRule[] = [];
  if (!overrides || typeof overrides !== 'object') return out;
  for (const id of OVERRIDE_STAGE_ORDER) {
    const raw = (overrides as any)[id];
    if (!Array.isArray(raw)) continue;
    const names = raw
      .map((n) => String(n == null ? '' : n).trim().toLowerCase())
      .filter((n) => n.length > 0 && n.length <= 40)
      .slice(0, 20);
    if (names.length === 0) continue;
    const alts = names.map(escapeRegex).join('|');
    out.push({ id, test: new RegExp(`^(?:${alts})([-_/].*)?$`) });
  }
  return out;
}

/**
 * 规则缓存：同一个配置每轮询都会进 resolvePipelineStage，
 * 每次重建 RegExp 是白烧 CPU。按配置内容做单槽记忆即可（配置变化很少）。
 */
let overrideMemoKey = 'null';
let overrideMemoRules: StageRule[] = [];

function overrideRules(overrides?: StageOverrides | null): StageRule[] {
  const key = JSON.stringify(overrides || null);
  if (key !== overrideMemoKey) {
    overrideMemoKey = key;
    overrideMemoRules = buildStageOverrideRules(overrides);
  }
  return overrideMemoRules;
}

function matchBranch(value: unknown, overrides?: StageOverrides | null): PipelineStageId | null {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return null;
  // 去掉远端前缀：origin/dev、upstream/dev、refs/heads/release/1.2。
  // 这里绝不能用一个通用的「砍掉第一段」——那会把 release/1.2 砍成 1.2、
  // 把 feature/dev-tools 砍成 dev-tools，两个都会判错阶段。
  const bare = v
    .replace(/^refs\/heads\//, '')
    .replace(/^(origin|upstream|remotes\/[^/]+)\//, '');
  // 用户规则先走一遍：这就是「我把 uat 归到生产」能生效的原因——
  // 否则内置的 test 规则会先把 uat 抢走。
  for (const rule of overrideRules(overrides)) {
    if (rule.test.test(v) || (bare !== v && rule.test.test(bare))) return rule.id;
  }
  for (const rule of BRANCH_RULES) {
    if (rule.test.test(v) || (bare !== v && rule.test.test(bare))) return rule.id;
  }
  return null;
}

/** label 形如 `stage:test` / `pipeline=release` / `env/prod` / `环境:测试` */
function matchLabel(labels: unknown, overrides?: StageOverrides | null): { id: PipelineStageId; value: string } | null {
  const list = Array.isArray(labels) ? labels : [];
  for (const raw of list) {
    const label = typeof raw === 'string' ? raw : String((raw && (raw as any).name) || '');
    const text = label.trim().toLowerCase();
    if (!text) continue;
    // 只认「阶段键 + 阶段值」形态，避免普通标签（bug/test-flaky）误判
    const m = text.match(/^(?:stage|pipeline|env|environment|环境|阶段)\s*[:/=_-]\s*(.+)$/);
    if (!m) continue;
    const id = matchBranch(m[1], overrides);
    if (id) return { id, value: label };
  }
  return null;
}

export interface StageInput {
  baseRefName?: unknown;
  headRefName?: unknown;
  labels?: unknown;
}

/**
 * 解析单个 PR/分支的流水线阶段。
 * `overrides` 来自插件配置 `pipelineStages`，不传则用内置规则。
 */
export function resolvePipelineStage(input: StageInput | null | undefined, overrides?: StageOverrides | null): ResolvedStage {
  const src = input || {};
  const byLabel = matchLabel(src.labels, overrides);
  if (byLabel) {
    const st = stageById(byLabel.id);
    return { id: st.id, label: st.label, labelZh: st.labelZh, order: st.order, matchedBy: 'label', matchedValue: byLabel.value };
  }
  const byBase = matchBranch(src.baseRefName, overrides);
  if (byBase) {
    const st = stageById(byBase);
    return { id: st.id, label: st.label, labelZh: st.labelZh, order: st.order, matchedBy: 'base', matchedValue: String(src.baseRefName || '') };
  }
  const byHead = matchBranch(src.headRefName, overrides);
  if (byHead) {
    const st = stageById(byHead);
    return { id: st.id, label: st.label, labelZh: st.labelZh, order: st.order, matchedBy: 'head', matchedValue: String(src.headRefName || '') };
  }
  const other = stageById('other');
  return { id: other.id, label: other.label, labelZh: other.labelZh, order: other.order, matchedBy: 'none', matchedValue: '' };
}

/**
 * 同一阶段内部的次序：
 *   1. 待审/open 在前，草稿随后，已合并/已关闭沉底（它们已经走完这一段）；
 *   2. 同状态按更新时间倒序（刚动过的排前面）；
 *   3. 最后按编号倒序兜底，保证刷新之间顺序稳定。
 */
export function prStateRank(item: any): number {
  const it = item || {};
  const mergedAt = String(it.mergedAt || '');
  const state = String(it.state || '').toUpperCase();
  if (mergedAt) return 2;
  if (state === 'CLOSED') return 3;
  if (it.isDraft) return 1;
  return 0;
}

function timeValue(item: any): number {
  const raw = String((item && (item.updatedAt || item.at)) || '');
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return t;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function comparePrsByStage(a: any, b: any): number {
  const sa = Number.isFinite(a && a.stage && a.stage.order) ? a.stage.order : stageById(a && a.stageId).order;
  const sb = Number.isFinite(b && b.stage && b.stage.order) ? b.stage.order : stageById(b && b.stageId).order;
  if (sa !== sb) return sa - sb;

  const ra = prStateRank(a);
  const rb = prStateRank(b);
  if (ra !== rb) return ra - rb;

  const ta = timeValue(a);
  const tb = timeValue(b);
  if (ta !== tb) return tb - ta;

  const na = Number(a && a.number) || 0;
  const nb = Number(b && b.number) || 0;
  return nb - na;
}

/**
 * 给条目补上阶段并排序（不修改入参）。
 * 已经带 `stage.order` 的条目直接复用，避免重复解析。
 */
export function sortPrsByStage<T extends Record<string, any>>(items: T[]): T[] {
  const list = Array.isArray(items) ? items.slice() : [];
  // 泛型 T 上可能还没有 stage 字段（调用方给的是原始 PR 行），这里按索引写回
  for (const item of list as any[]) {
    if (!item || item.stage) continue;
    const resolved = resolvePipelineStage(item);
    item.stageId = resolved.id;
    item.stage = resolved;
  }
  return list.sort(comparePrsByStage);
}

export interface StageGroup<T> {
  stage: PipelineStage;
  items: T[];
}

/** 按阶段分组，空阶段不返回（浮窗不想要 5 个空泳道） */
export function groupPrsByStage<T extends Record<string, any>>(items: T[]): Array<StageGroup<T>> {
  const sorted = sortPrsByStage(items);
  const buckets = new Map<string, T[]>();
  for (const item of sorted) {
    const id = String(item.stageId || 'other');
    const list = buckets.get(id) || [];
    list.push(item);
    buckets.set(id, list);
  }
  const out: Array<StageGroup<T>> = [];
  for (const st of PIPELINE_STAGES) {
    const list = buckets.get(st.id);
    if (list && list.length) out.push({ stage: st, items: list });
  }
  return out;
}

/**
 * 功能维度聚合：同一个功能在 Dev→Test→Release 之间流转时，head 分支通常不变，
 * 只是 base 一路往上换。按 headRefName 归组，就能把「同一功能的几个 PR」
 * 收成一条泳道，看出它当前停在最靠后的那个阶段。
 */
export interface FeatureGroup<T> {
  /** headRefName；拿不到时退化成 repo#number，保证每组唯一 */
  key: string;
  items: T[];
  /** 走得最远的那个阶段（阶段序号最大） */
  furthest: PipelineStage;
  /** 是否已经全部合并 */
  done: boolean;
  /** 展示名（原始分支名，或标签值）；缺省时用 key */
  label?: string;
  /** 分组依据：label（人工显式指定）优先于 branch（分支名推断） */
  source?: 'label' | 'branch';
}

/**
 * 「走到最远」不能直接用 stage.order：`other` 的 order 是 99（排序时沉底），
 * 拿它当起点会导致任何真实阶段都比不过，功能永远显示停在 Other。
 * 所以另开一个「推进度」标尺，未归类记为 -1。
 */
function advanceRank(stage: PipelineStage | null | undefined): number {
  if (!stage) return -1;
  return stage.id === 'other' ? -1 : stage.order;
}

/**
 * 版本号提取（与 src/ui/pr-lanes.ts 的客户端实现保持同一口径）：
 * 同一变更经常以不同 head 名在多个分支间搬运，按 head 归组会把它拆成多条泳道。
 * 这批 PR 共有的稳定信号是版本号，优先按版本聚合，没有版本号才退回 head。
 */
const FEATURE_NOISE_TOKENS = new Set([
  'release', 'rel', 'sync', 'to', 'into', 'from', 'main', 'master',
  'dev', 'develop', 'test', 'qa', 'staging', 'merge', 'branch',
]);

/** 分支名归一：去类型前缀、去尾部日期、下划线转连字符 */
export function normalizeBranchSlug(head: any): string {
  let slug = String(head == null ? '' : head).toLowerCase().replace(/_/g, '-');
  slug = slug.replace(/^(fix|feat|feature|chore|hotfix|bugfix|sync|rel|release|ci)\//, '');
  slug = slug.replace(/-?\d{8}(-v\d+)?$/, '');
  // 剥掉「同步到某分支」的套话尾巴，避免用 cleanup-to-main 这类词串误并
  slug = slug.replace(/-?(to|into)-(main|master|dev|development|test|release[^-]*)(-\d{8})?$/, '');
  return slug.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
}

function normalizeBaseName(base: any): string {
  return String(base == null ? '' : base).toLowerCase().replace(/_/g, '-');
}

function hasVersionToken(text: any): boolean {
  return /\d+\.\d+\.\d+/.test(String(text == null ? '' : text));
}

function commonTokenRun(a: string, b: string): string[] {
  const A = String(a || '').split(/[-/]/).filter(Boolean);
  const B = String(b || '').split(/[-/]/).filter(Boolean);
  let best: string[] = [];
  let prev = new Array(B.length + 1).fill(0) as number[];
  for (let i = 1; i <= A.length; i += 1) {
    const cur = new Array(B.length + 1).fill(0) as number[];
    for (let j = 1; j <= B.length; j += 1) {
      if (A[i - 1] === B[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best.length) best = A.slice(i - cur[j], i);
      }
    }
    prev = cur;
  }
  return best;
}

function versionTokensOf(slug: string): string[] {
  return (slug.match(/v?(\d+\.\d+\.\d+)/g) || []).map((v) => v.replace(/^v/, ''));
}

function topicTokensOf(slug: string): string[] {
  return slug.split(/[-/]/).filter((t) => t.length >= 4 && !FEATURE_NOISE_TOKENS.has(t) && !/^v?\d/.test(t));
}

/**
 * 两个分支名是否属于同一条链（详见 src/ui/pr-lanes.ts 的同名实现）：
 * a) 派生分支名包含源分支名；b) 同版本 + 共享主题词。
 */
function sameChain(a: any, b: any): boolean {
  if (a.featureLabel || b.featureLabel) {
    return Boolean(a.featureLabel) && a.featureLabel === b.featureLabel;
  }
  if (a.slug && a.slug === b.slug) return true;
  // 版本互斥：两边都带版本号却无交集 → 不同批次
  if (a.versions.length > 0 && b.versions.length > 0
    && !a.versions.some((v: string) => b.versions.includes(v))) return false;
  const shortSlug = a.slug.length <= b.slug.length ? a.slug : b.slug;
  const longSlug = a.slug.length <= b.slug.length ? b.slug : a.slug;
  if (shortSlug.length >= 6 && longSlug.includes(shortSlug)) return true;
  const run = commonTokenRun(a.slug, b.slug);
  if (run.length >= 2 && run.join('-').length >= 8) return true;
  for (const [src, dst] of [[a, b], [b, a]] as const) {
    const base = normalizeBaseName(src.baseRefName);
    if (hasVersionToken(base) && base.length >= 8 && dst.slug.includes(base)) return true;
  }
  const sharedVersion = a.versions.some((v: string) => b.versions.includes(v));
  if (!sharedVersion) return false;
  return a.topics.some((t: string) => b.topics.includes(t));
}

/**
 * 从 PR 标签里取功能名（`feature:xxx` / `feature/xxx` / `feature=xxx`）。
 * 唯一由人显式指定的归组信号：两边都有标签时完全以标签为准。
 */
export function featureLabelOfItem(item: any): string {
  const labels = item?.labels;
  const list = Array.isArray(labels) ? labels : [];
  for (const raw of list) {
    const name = typeof raw === 'string' ? raw : String(raw?.name || '');
    const m = name.trim().match(/^feature\s*[:/=]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return '';
}

/** 单条 PR 的归一化信息（导出供测试） */
export function featureRowOf(item: any) {
  const slug = normalizeBranchSlug(item?.headRefName);
  return { slug, head: String(item?.headRefName || '').trim(), baseRefName: String(item?.baseRefName || ''), versions: versionTokensOf(slug), topics: topicTokensOf(slug), featureLabel: featureLabelOfItem(item) };
}

export function groupPrsByFeature<T extends Record<string, any>>(items: T[]): Array<FeatureGroup<T>> {
  const sorted = sortPrsByStage(items);
  const rows = sorted.map((item) => ({ item, ...featureRowOf(item) }));

  // 并查集：只有同链才连（包含关系 / 同版本+共享主题词）
  const parent = rows.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (sameChain(rows[i], rows[j])) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }

  const buckets = new Map<number, typeof rows>();
  rows.forEach((row, idx) => {
    const root = find(idx);
    const list = buckets.get(root) || [];
    list.push(row);
    buckets.set(root, list);
  });

  const out: Array<FeatureGroup<T>> = [];
  for (const list of buckets.values()) {
    // 组名取「最短且够长」的 slug：太短的（v1.0.79、ci）不适合当标签
    const slugs = list.map((r) => r.slug).filter(Boolean).sort((a, b) => a.length - b.length);
    const byLabel = list[0]?.featureLabel || '';
    let commonRun = '';
    if (!byLabel && list.length > 1) {
      const runs = new Map<string, number>();
      for (let x = 0; x < list.length; x += 1) {
        for (let y = x + 1; y < list.length; y += 1) {
          const cr = commonTokenRun(list[x].slug, list[y].slug);
          if (cr.length >= 2 && cr.join('-').length >= 8) {
            const k = cr.join('-');
            runs.set(k, (runs.get(k) || 0) + 1);
          }
        }
      }
      const best = [...runs.entries()].sort((p, q) => q[1] - p[1] || p[0].length - q[0].length)[0];
      commonRun = best ? best[0] : '';
    }
    const key = byLabel
      ? `label:${byLabel}`
      : (commonRun || slugs.find((k) => k.length >= 8) || slugs[0] || `${list[0].item?.repo || ''}#${list[0].item?.number || ''}`);
    const source: 'label' | 'branch' = byLabel ? 'label' : 'branch';
    let furthest: PipelineStage | null = null;
    let furthestRank = -1;
    let done = true;
    for (const row of list) {
      const stage = (row.item && row.item.stage) || null;
      const rank = advanceRank(stage);
      if (rank > furthestRank) { furthest = stage; furthestRank = rank; }
      if (!(row.item && row.item.mergedAt) && String((row.item && row.item.state) || '').toUpperCase() !== 'CLOSED') done = false;
    }
    const labelRow = byLabel ? null : list.find((r) => r.slug === key);
    const isDerived = (h: string) => /^sync\//i.test(h) || /\d{8}(-v\d+)?$/.test(h);
    let label = byLabel || commonRun;
    if (!byLabel && commonRun) {
      const exact = list.filter((r) => r.slug === commonRun && r.head);
      const exactOrigin = exact.filter((r) => !isDerived(r.head));
      if (exactOrigin.length) label = exactOrigin[0].head;
      else if (exact.length) label = exact[0].head;
    }
    if (!label) {
      const origins = list.map((r) => r.head).filter((h) => h && !isDerived(h));
      if (origins.length) {
        label = origins.sort((a, b) => a.length - b.length)[0];
      } else {
        const exact = list.find((r) => r.slug === key);
        label = exact ? exact.head : '';
      }
    }
    out.push({ key, label: label || key, source, items: list.map((r) => r.item), furthest: furthest || stageById('other'), done });
  }

  // 未完成的在前；再按走得最远的阶段升序（Dev 在前），与阶段泳道同向
  return out.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ra = advanceRank(a.furthest);
    const rb = advanceRank(b.furthest);
    if (ra !== rb) return ra - rb;
    return timeValue(b.items[0]) - timeValue(a.items[0]);
  });
}
