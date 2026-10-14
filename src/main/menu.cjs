/**
 * The application menu, and the theme the page is showing.
 *
 * The menu is this app's only keyboard surface: it owns the document picker the empty
 * state advertises, and the theme preference the reader's chrome follows. The applied
 * palette — not the last request — is what the checkbox must describe, so it is read back
 * from the page.
 *
 * Built against a window accessor rather than a window, because the window is replaced
 * between launches and the menu outlives it.
 */
const { Menu } = require('electron');
const { trace } = require('./trace.cjs');

/** The theme this app boots with: the dark reading surface DSH shows. */
const THEME_DEFAULT = 'dark';

/** The menu item whose state must agree with the page. */
const THEME_ITEM_ID = 'view.dark-theme';

/**
 * Create the menu for one process.
 * @param options - `{ getWindow }`, the accessor for the window currently showing.
 */
function createMenu({ getWindow }) {
  /** The preference and the palette in force are not the same thing; this is the palette. */
  let appliedTheme = THEME_DEFAULT;
  /** The menu, so its checkbox can be corrected after a change or a launch. */
  let applicationMenu;

  /** Ask the page which palette it is showing. */
  async function refreshAppliedTheme() {
    try {
      const shown = await getWindow()?.webContents.executeJavaScript('globalThis.__DSH_VIEWER__?.theme?.()');
      if (shown === 'dark' || shown === 'light') appliedTheme = shown;
    } catch {
      // A page that cannot be reached leaves the last known value.
    }
    syncThemeMenuItem();
    return appliedTheme;
  }

  /** Keep the checkbox honest: it shows the palette in force, not the request. */
  function syncThemeMenuItem() {
    const item = applicationMenu?.getMenuItemById(THEME_ITEM_ID);
    if (item !== null && item !== undefined) item.checked = appliedTheme === 'dark';
  }

  /** Change the theme and tell the page, in one place. */
  async function setPreference(next) {
    const accepted = await getWindow()
      ?.webContents.executeJavaScript(`globalThis.__DSH_VIEWER_SET_THEME__?.(${JSON.stringify(next)})`)
      .catch(() => false);
    if (accepted !== true) trace(`theme change to ${next} was refused or unreachable`);
    await refreshAppliedTheme();
  }

  /** Install the application menu. */
  function installMenu() {
    applicationMenu = Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          {
            // The one document-opening command, and the shortcut the empty state
            // advertises. It runs the page's own picker so both entry points share one
            // code path.
            label: '打开文件…',
            accelerator: 'CmdOrCtrl+O',
            click: () => getWindow()?.webContents.executeJavaScript('globalThis.__DSH_VIEWER_PICK__?.()').catch(() => {}),
          },
          { type: 'separator' },
          { role: 'quit', label: '退出' },
        ],
      },
      {
        label: '视图',
        submenu: [
          {
            // The reader's chrome follows the system preference by default, and DSH shows
            // it dark; this makes the app match, and lets the choice be changed. Its state
            // is corrected from the page, so it always describes what is on screen.
            id: THEME_ITEM_ID,
            label: '深色主题',
            type: 'checkbox',
            checked: appliedTheme === 'dark',
            click: (item) => setPreference(item.checked ? 'dark' : 'light'),
          },
          { type: 'separator' },
          { role: 'reload', label: '重新载入' },
          { role: 'toggleDevTools', label: '开发者工具' },
          { type: 'separator' },
          { role: 'resetZoom', label: '实际大小' },
          { role: 'zoomIn', label: '放大' },
          { role: 'zoomOut', label: '缩小' },
          { type: 'separator' },
          { role: 'togglefullscreen', label: '全屏' },
        ],
      },
      { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' }] },
    ]);
    Menu.setApplicationMenu(applicationMenu);
  }

  return { installMenu, refreshAppliedTheme };
}

module.exports = { createMenu, THEME_DEFAULT };
