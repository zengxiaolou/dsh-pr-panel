/**
 * 轻量 Markdown 渲染（PR 正文 / 评审评论用）与按文件切分 unified diff。
 *
 * 只保留面板真正需要的两个函数：前身项目里的 commit/issues 渲染器已经删掉。
 * 渲染全部走 React 元素（不用 innerHTML），链接/图片在白名单里校验协议，
 * 挡住 `javascript:` / `file:` 这类注入面。
 */

export function splitDiffByFile(patch: string): Array<{ path: string; text: string; additions: number; deletions: number }> {
  var text = String(patch || '');
  if (!text) return [];
  var parts = text.split(/^diff --git /m).filter(function (p) { return p.trim() !== ''; });
  return parts.map(function (body) {
    var full = 'diff --git ' + body;
    var nameMatch = body.match(/a\/(\S+) b\/(\S+)/);
    var filePath = nameMatch ? nameMatch[2] : (body.split('\n')[0] || '未知文件');
    var additions = 0;
    var deletions = 0;
    full.split('\n').forEach(function (line) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    });
    return { path: filePath, text: full, additions: additions, deletions: deletions };
  });
}

/** 行内元素：`code`、**bold**、[text](url) */
function renderInline(h: any, text: string, keyBase: string) {
  var nodes: any[] = [];
  var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))/g;
  var last = 0;
  var m: RegExpExecArray | null;
  var i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    var token = m[0];
    if (token.charAt(0) === '`') {
      nodes.push(h('code', { key: keyBase + '-' + i, style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.92em', padding: '1px 4px', borderRadius: '4px', background: 'rgba(127,127,127,.16)' } }, token.slice(1, -1)));
    } else if (token.slice(0, 2) === '**') {
      nodes.push(h('strong', { key: keyBase + '-' + i }, token.slice(2, -2)));
    } else if (token.slice(0, 2) === '![') {
      // 图片：PR 正文里的截图很常见，直接渲染；宽度跟容器走
      var im = token.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      var imgSrc = im ? safeImgSrc(im[2]) : '';
      if (im && imgSrc) {
        nodes.push(h('img', {
          key: keyBase + '-' + i,
          src: imgSrc,
          alt: im[1] || '',
          loading: 'lazy',
          style: { maxWidth: '100%', borderRadius: '8px', margin: '4px 0', display: 'block', border: '1px solid rgba(127,127,127,.2)' },
        }));
      }
    } else {
      var lm = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      var href = lm ? safeHref(lm[2]) : '';
      if (lm && href) {
        nodes.push(h('a', {
          key: keyBase + '-' + i, href, target: '_blank', rel: 'noopener noreferrer',
          style: { color: 'var(--dsw-alias-link,#0969da)' },
        }, lm[1]));
      } else if (lm) {
        // 不安全协议：保留可读文本，别让它变成可点的坑
        nodes.push(lm[1] + '（链接已隐藏）');
      }
    }
    last = m.index + token.length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** markdown-lite：标题、无序/有序列表、围栏代码、段落 */
/**
 * 链接/图片白名单。
 *
 * 为什么必须做：PR 正文、评审评论都是**外部输入**。之前直接把 `[x](target)` 的 target
 * 塞进 href，`[点我](javascript:alert(1))` 就能在 Electron 渲染进程里执行脚本（那里
 * 挂着 DSH 的 bridge）。图片同理：`file://` 能读本机文件当图片显示。
 * 只放行 https（以及内联 base64 图片），其余一律降级成纯文本。
 */
function safeHref(raw: string): string {
  const u = String(raw || '').trim();
  return /^https?:\/\//i.test(u) ? u : '';
}

function safeImgSrc(raw: string): string {
  const u = String(raw || '').trim();
  if (/^https:\/\//i.test(u)) return u;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(u)) return u;
  return '';
}

export function renderMarkdownLite(h: any, source: string) {
  var lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  var out: any[] = [];
  var i = 0;
  var key = 0;
  var para: string[] = [];

  var flushPara = function () {
    if (para.length === 0) return;
    var text = para.join(' ').trim();
    if (text) out.push(h('p', { key: 'p' + key++, style: { margin: '0 0 10px', lineHeight: '1.65' } }, renderInline(h, text, 'pi' + key)));
    para = [];
  };

  while (i < lines.length) {
    var line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      var buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(h('pre', {
        key: 'pre' + key++,
        style: { margin: '0 0 12px', padding: '10px 12px', borderRadius: '8px', overflow: 'auto', background: 'rgba(127,127,127,.12)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', lineHeight: '1.5' },
      }, buf.join('\n')));
      continue;
    }
    var hm = line.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      flushPara();
      var level = hm[1].length;
      out.push(h('h' + Math.min(level + 2, 6), { key: 'h' + key++, style: { margin: '14px 0 8px', fontSize: level <= 2 ? '16px' : '14px', fontWeight: 600, lineHeight: '1.4' } }, renderInline(h, hm[2], 'hi' + key)));
      i += 1;
      continue;
    }
    // 表格：表头行 + 分隔行（|---|）
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara();
      var parseRow = function (row: string) {
        return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
      };
      var head = parseRow(line);
      i += 2;
      var bodyRows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { bodyRows.push(parseRow(lines[i])); i += 1; }
      out.push(h('div', { key: 'tbl' + key++, style: { overflowX: 'auto', margin: '0 0 12px' } },
        h('table', { style: { borderCollapse: 'collapse', width: '100%', fontSize: '12px' } },
          h('thead', null, h('tr', null, head.map(function (cell, ci) {
            return h('th', { key: ci, style: { textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,.3)', fontWeight: 600, whiteSpace: 'nowrap' } }, renderInline(h, cell, 'th' + ci));
          }))),
          h('tbody', null, bodyRows.map(function (row, ri) {
            return h('tr', { key: ri }, row.map(function (cell, ci) {
              return h('td', { key: ci, style: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,.14)', verticalAlign: 'top' } }, renderInline(h, cell, 'td' + ri + '-' + ci));
            }));
          }))
        )
      ));
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flushPara();
      var ordered = /^\s*\d+\./.test(line);
      var items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        i += 1;
      }
      out.push(h(ordered ? 'ol' : 'ul', { key: 'l' + key++, style: { margin: '0 0 12px', paddingLeft: '22px', lineHeight: '1.7' } },
        items.map(function (t, idx) { return h('li', { key: idx }, renderInline(h, t, 'li' + idx)); })));
      continue;
    }
    if (line.trim() === '') { flushPara(); i += 1; continue; }
    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return out;
}
