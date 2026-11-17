export const SITE_ORIGIN = 'https://serteknik.elektrik.workers.dev';
export const SESSION_KEY = 'sershell_session_token';
export const DEVICE_SESSION_KEY = 'serteknik.session.v1';

export function isTrustedUrl(value: string): boolean {
  try { return new URL(value).origin === SITE_ORIGIN; } catch { return false; }
}
export function navigationAction(value: string): 'internal' | 'external' | 'blocked' {
  if (value === 'about:blank' || isTrustedUrl(value)) return 'internal';
  try {
    const protocol = new URL(value).protocol;
    return ['https:', 'tel:', 'mailto:', 'whatsapp:'].includes(protocol) ? 'external' : 'blocked';
  } catch { return 'blocked'; }
}

export const BACK_SCRIPT = `
(function(){
  if(location.origin!==${JSON.stringify(SITE_ORIGIN)})return;
  var dialogs=Array.from(document.querySelectorAll('[role="dialog"]')).filter(function(d){return d.getBoundingClientRect().height>0});
  var top=dialogs[dialogs.length-1];
  if(top){var close=top.querySelector('.srk-modal-close');if(close){close.click();return;}}
  window.ReactNativeWebView.postMessage(JSON.stringify({type:'BACK_READY',historyLength:history.length}));
})();true;
`;
