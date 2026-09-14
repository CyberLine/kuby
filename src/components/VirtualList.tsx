import { createMemo, createSignal, For, type JSX, onCleanup, onMount } from "solid-js";

type Props<T> = {
  items: T[];
  itemHeight: number;
  renderItem: (item: T, index: number) => JSX.Element;
  header?: JSX.Element;
  class?: string;
  overscan?: number;
};

/** Lightweight virtual list for thousands of Kubernetes objects. */
export function VirtualList<T>(props: Props<T>) {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(400);
  let scroller!: HTMLDivElement;
  const overscan = () => props.overscan ?? 8;

  onMount(() => {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setHeight(e.contentRect.height);
    });
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
  });

  const total = createMemo(() => props.items.length * props.itemHeight);
  const start = createMemo(() =>
    Math.max(0, Math.floor(scrollTop() / props.itemHeight) - overscan()),
  );
  const end = createMemo(() =>
    Math.min(
      props.items.length,
      Math.ceil((scrollTop() + height()) / props.itemHeight) + overscan(),
    ),
  );
  const slice = createMemo(() => props.items.slice(start(), end()));

  return (
    <div class={`virtual-list ${props.class || ""}`}>
      {props.header}
      <div
        class="virtual-scroll"
        ref={scroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div class="virtual-spacer" style={{ height: `${total()}px` }}>
          <div
            class="virtual-window"
            style={{
              transform: `translateY(${start() * props.itemHeight}px)`,
            }}
          >
            <For each={slice()}>
              {(item, i) => (
                <div class="virtual-row" style={{ height: `${props.itemHeight}px` }}>
                  {props.renderItem(item, start() + i())}
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
