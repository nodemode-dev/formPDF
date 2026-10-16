// veraPDF, the reference validator, run by the engine when it is installed. Shared by the Accessibility tab (PDF/UA)
// and the Print tab (PDF/A). The buttons stay in place and are disabled while veraPDF is missing, so panels keep their height.
import { pdfApi } from '../pdf/api';
import type { ToolHost } from '../pdf/tools';
import { el, patchList, q, setDisabled, setHidden, setText } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';

export interface VeraRule { clause: string; test: string; failed: number; text: string; pages: number[] }
export interface VeraReport { text: string; compliant: boolean; flavour: string; profile: string; version: string; rules: VeraRule[] }

let known: boolean | null = null;
let asking: Promise<boolean> | null = null;

/** Whether the engine finds veraPDF; asked once per session, through any open document. */
export function veraKnown(): boolean | null { return known; }

export async function veraInstalled(id: string, onKnown: () => void): Promise<boolean> {
  if (known !== null) return known;
  if (!asking) {
    asking = pdfApi.act<{ installed: boolean }>(id, 'verapdf_status').then((r) => { known = !!r.installed; return known; }).catch(() => { asking = null; return false; });
  }
  const got = await asking;
  onKnown();
  return got;
}

export async function runVera(host: ToolHost, flavour: string): Promise<{ report: VeraReport; id: string } | null> {
  const d = host.doc();
  if (!d) return null;
  let out: { report: VeraReport; id: string } | null = null;
  await host.ctx.run('Validating with veraPDF', async () => {
    try {
      const id = await host.ctx.flush() ?? d.id;
      out = { report: await pdfApi.act<VeraReport>(id, 'verapdf', flavour ? { flavour } : {}), id };
    } catch (err) { toast((err as Error).message, 'error'); }
  });
  return out;
}

function fillRule(n: HTMLElement, x: VeraRule): void {
  const ico = q(n, '.fs-acc-ico');
  if (!ico.dataset.s) { ico.innerHTML = icon('warning', 14); ico.dataset.s = 'bad'; }
  setText(q(n, '.fs-row-title'), `${x.clause}-${x.test} · ${x.text}`);
  const list = `${x.pages.slice(0, 12).join(', ')}${x.pages.length > 12 ? '…' : ''}`;
  // whole phrases joined in code, so each part translates on its own
  setText(q(n, '.fs-row-sub'), [`Failed checks: ${x.failed}`, ...(x.pages.length === 1 ? [`Page ${list}`] : x.pages.length ? [`Pages ${list}`] : [])].join(' · '));
  n.title = `${x.clause}-${x.test} ${x.text}`;
}

/** Shows a report (or the reason there is none) in a note, a list and its empty line. */
export function showVera(root: HTMLElement, attr: string, report: VeraReport | null, fresh: boolean): void {
  const note = q(root, `[${attr}="vnote"]`);
  const n = report?.rules.length ?? 0;
  setText(note, known === false ? 'The veraPDF validator is not installed. Put the verapdf command (from verapdf.org) on the PATH or in the data folder\'s tools folder to check the file against the official test suite.'
    : !report ? 'The reference validator veraPDF checks the file against the official test suite.'
      : !fresh ? 'These results are for an earlier version. Check again.'
        : report.compliant ? `Validated by veraPDF ${report.version}: the file meets ${report.profile}.`
          : n === 1 ? `Validated by veraPDF ${report.version}: the file does not meet ${report.profile}; ${n} rule fails.`
            : `Validated by veraPDF ${report.version}: the file does not meet ${report.profile}; ${n} rules fail.`);
  const items = report && fresh ? report.rules : [];
  patchList(q(root, `[${attr}="vlist"]`), items, {
    key: (x) => `${x.clause}-${x.test}`,
    create: (x) => { const n = el(`<div class="fs-row fs-tool-row"><span class="fs-row-icon fs-acc-ico is-bad"></span><span class="fs-row-main"><span class="fs-row-title"></span><span class="fs-row-sub"></span></span></div>`); fillRule(n, x); return n; },
    update: fillRule,
  });
  const empty = q(root, `[${attr}="vempty"]`);
  setHidden(empty, items.length > 0);
  setText(empty, report && fresh && report.compliant ? 'No rule fails.' : 'Failed rules are listed here with their clause.');
  setDisabled(q<HTMLButtonElement>(root, `[${attr}="vera"]`), known !== true);
}
