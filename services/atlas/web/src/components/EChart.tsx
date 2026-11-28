// ECharts with only the pieces used (tree-shaken), resized with its box,
// re-themed when the OS switches between dark and light.
import { BarChart, LineChart, PieChart } from "echarts/charts";
import { GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { useEffect, useRef, useState } from "react";

echarts.use([LineChart, BarChart, PieChart, GridComponent, TooltipComponent, LegendComponent, MarkAreaComponent, SVGRenderer]);

export type EChartsOption = echarts.EChartsCoreOption;

/** Resolve a CSS variable (the theme tokens) to a colour ECharts can use. */
export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function useColorScheme() {
  const q = "(prefers-color-scheme: light)";
  const [light, setLight] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setLight(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return light ? "light" : "dark";
}

export function EChart({ option, className, onClick }: { option: EChartsOption; className?: string; onClick?: (p: { name: string; seriesName?: string }) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const scheme = useColorScheme();

  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const text = cssVar("--color-muted");
    const line = cssVar("--color-line");
    c.setOption(
      {
        backgroundColor: "transparent",
        textStyle: { color: text, fontFamily: "inherit" },
        tooltip: {
          backgroundColor: cssVar("--color-panel-2"),
          borderColor: line,
          textStyle: { color: cssVar("--color-fg"), fontSize: 12 },
        },
        ...option,
      },
      true,
    );
  }, [option, scheme]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onClick) return;
    const h = (p: unknown) => onClick(p as { name: string; seriesName?: string });
    c.on("click", h);
    return () => {
      c.off("click", h);
    };
  }, [onClick]);

  return <div ref={ref} className={className} />;
}
