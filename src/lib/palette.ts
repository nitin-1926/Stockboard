// Colorblind-safe gain/loss: `data-palette="cb"` on <html> swaps the --gain/--loss tokens
// (globals.css). Persisted in localStorage; PALETTE_SCRIPT (root layout) applies it before
// first paint so there is no flash. Plain module: a "use client" file can't export a string
// to a server component.
export const PALETTE_KEY = "sb-palette";
export const PALETTE_SCRIPT = `try{if(localStorage.getItem("${PALETTE_KEY}")==="cb")document.documentElement.dataset.palette="cb"}catch(e){}`;
