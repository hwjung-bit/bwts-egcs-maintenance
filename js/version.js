// Build stamp for module-cache detection.
// index.html loads app.js?v=BUILD (never cached stale), but the modules it
// imports carry no query and GitHub Pages serves them with max-age=600.
// app.js compares its own ?v with this BUILD: a mismatch means the browser
// still holds old modules, so it re-fetches FILES with cache:'reload' and
// reloads. Bump BUILD together with index.html ?v= and version.json.
export const BUILD = '20260904a';

export const FILES = [
  'js/version.js', 'js/app.js',
  'js/core/auth.js', 'js/core/dom.js', 'js/core/router.js', 'js/core/state.js', 'js/core/supabase.js',
  'js/shared/constants.js', 'js/shared/dates.js', 'js/shared/drive.js', 'js/shared/ships.js', 'js/shared/thresholds.js',
  'js/tabs/home.js', 'js/tabs/mail.js', 'js/tabs/repairs.js', 'js/tabs/status.js', 'js/tabs/bwtsLog.js',
  'js/tabs/bwtsCal.js', 'js/tabs/egcsCal.js', 'js/tabs/ships.js',
  'css/base.css', 'contracts/thresholds.json',
];
