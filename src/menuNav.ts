import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * 下拉菜单键盘导航：在容器内已渲染的 menuitem 之间移动焦点。
 * 原生 <button> 的 Enter/空格由浏览器自行触发 click，这里只补非按钮元素的激活。
 */
export function menuKeyNav(ev: ReactKeyboardEvent<HTMLElement>, dismiss: () => void) {
  const items = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  if (items.length === 0) return;
  const idx = items.findIndex((el) => el === document.activeElement);
  const focusAt = (i: number) => items[(i + items.length) % items.length].focus();
  switch (ev.key) {
    case "ArrowDown":
      ev.preventDefault();
      focusAt(idx < 0 ? 0 : idx + 1);
      break;
    case "ArrowUp":
      ev.preventDefault();
      focusAt(idx < 0 ? items.length - 1 : idx - 1);
      break;
    case "Home":
      ev.preventDefault();
      focusAt(0);
      break;
    case "End":
      ev.preventDefault();
      focusAt(items.length - 1);
      break;
    case "Enter":
    case " ":
      if (idx >= 0 && items[idx].tagName !== "BUTTON") {
        ev.preventDefault();
        items[idx].click();
      }
      break;
    case "Escape":
      ev.preventDefault();
      dismiss();
      break;
    default:
      break;
  }
}
