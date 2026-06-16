// Event log → browser console. The UI no longer renders a log panel; every
// `logEvent(msg)` call across the app prints a timestamped line to the JS
// console instead. The function name/signature is unchanged so all existing
// call sites keep working.

const ts = () => new Date().toISOString().slice(11, 19);

export function logEvent(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[ttt ${ts()}] ${msg}`);
}

logEvent("app loaded");
