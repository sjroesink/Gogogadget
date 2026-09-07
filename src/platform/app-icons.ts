import { appIcon } from "./bridge";
const cache = new Map<string, Promise<string | null>>();
let observer: IntersectionObserver | undefined;
let queue: HTMLElement[] = [];
let running = 0;
function pump() {
  while (running < 2 && queue.length) {
    const node = queue.shift()!;
    if (!node.isConnected) continue;
    const id = node.dataset.appIcon!;
    running++;
    let request = cache.get(id);
    if (!request) {
      request = appIcon(id).catch(() => null);
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(id, request);
    }
    void request
      .then((url) => {
        if (node.isConnected && url?.startsWith("data:image/png;base64,")) {
          const img = new Image();
          img.alt = "";
          img.width = 28;
          img.height = 28;
          img.className = "app-icon";
          img.onload = () => {
            if (node.isConnected) node.replaceChildren(img);
          };
          img.src = url;
        }
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}
export function disconnectAppIcons() {
  observer?.disconnect();
  queue = [];
}
export function observeAppIcons(root: HTMLElement) {
  disconnectAppIcons();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          observer!.unobserve(entry.target);
          queue.push(entry.target as HTMLElement);
        }
      pump();
    },
    { root, rootMargin: "40px" },
  );
  root
    .querySelectorAll<HTMLElement>("[data-app-icon]")
    .forEach((node) => observer!.observe(node));
}
