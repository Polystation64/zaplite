import { reg } from "../nucleo.js";
import { invoke } from "../ponte.js";

/* 24. Sempre no topo ---------------------------------------------------- */
export function registrarSempreNoTopo() {
  reg({
    id: "alwaysOnTop",
    apply() {
      invoke("set_always_on_top", { value: true });
    },
    revert() {
      invoke("set_always_on_top", { value: false });
    },
  });
}
