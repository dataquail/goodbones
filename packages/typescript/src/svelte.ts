// A Svelte component is markup around at most two `<script>` blocks — the
// instance script and `<script module>` — and only those hold imports, exports
// and calls this pack reads. The markup is blanked rather than cut, every
// character but a line break turned to a space, so an offset into the script
// text is an offset into the file and a fact reports where it was written.
// oxlint lints the same blocks, so the CLI and the plugin read one program.
const SCRIPT_BLOCK = /(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/g;

const blank = (text: string): string => text.replace(/[^\n]/g, " ");

export const isSvelteComponent = (file: string): boolean => file.endsWith(".svelte");

export const scriptOfSvelteComponent = (text: string): string => {
  let script = "";
  let consumed = 0;

  for (const block of text.matchAll(SCRIPT_BLOCK)) {
    const [whole, open = "", body = ""] = block;
    script += blank(text.slice(consumed, block.index) + open) + body;
    consumed = block.index + whole.length - (block[3]?.length ?? 0);
  }

  return script + blank(text.slice(consumed));
};
