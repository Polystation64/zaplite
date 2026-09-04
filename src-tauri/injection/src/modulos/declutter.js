import { css, dropCss, reg, settings } from "../nucleo.js";

/* 26. Esconder Status / Canais / Comunidades --------------------------- */
export function registrarDeclutter() {
  reg({
    id: "declutter",
    apply() {
      const hide = [];
      if (settings.hide?.status) hide.push('[aria-label*="Status"]', '[data-icon="status-refreshed"]');
      if (settings.hide?.channels) hide.push('[aria-label*="Canais"]', '[aria-label*="Channels"]');
      if (settings.hide?.communities) hide.push('[aria-label*="Comunidades"]', '[aria-label*="Communities"]');
      css(hide.length ? hide.join(",") + "{display:none!important}" : "", "zl-declutter");
    },
    revert() {
      dropCss("zl-declutter");
    },
  });
}
