import { useEffect } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type SortDir = "asc" | "desc";

export interface SortOption<K extends string> {
  key: K;
  label: string;
}

export interface SortValue<K extends string> {
  by: K;
  dir: SortDir;
}

interface Props<K extends string> {
  options: ReadonlyArray<SortOption<K>>;
  value: SortValue<K>;
  onChange: (next: SortValue<K>) => void;
  /** localStorage key for persistence. Optional — pages that hydrate elsewhere can omit. */
  persistKey?: string;
}

export function readPersistedSort<K extends string>(
  persistKey: string,
  fallback: SortValue<K>,
  validKeys: ReadonlySet<K>,
): SortValue<K> {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(persistKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { by?: string; dir?: string };
    const by = parsed.by && validKeys.has(parsed.by as K) ? (parsed.by as K) : fallback.by;
    const dir: SortDir = parsed.dir === "asc" || parsed.dir === "desc" ? parsed.dir : fallback.dir;
    return { by, dir };
  } catch {
    return fallback;
  }
}

export function SortMenu<K extends string>({ options, value, onChange, persistKey }: Props<K>) {
  useEffect(() => {
    if (!persistKey) return;
    try {
      localStorage.setItem(persistKey, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  }, [persistKey, value]);

  const current = options.find((o) => o.key === value.by);
  const dirIcon = value.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="default" className="h-8 px-3 text-sm gap-1.5">
          <ArrowUpDown className="h-3.5 w-3.5" />
          <span className="text-muted-foreground">Sort:</span>
          <span>{current?.label ?? "Default"}</span>
          {dirIcon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value.by}
          onValueChange={(by) => onChange({ by: by as K, dir: value.dir })}
        >
          {options.map((opt) => (
            <DropdownMenuRadioItem key={opt.key} value={opt.key}>
              {opt.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault();
            onChange({ by: value.by, dir: value.dir === "asc" ? "desc" : "asc" });
          }}
        >
          <div className="flex items-center gap-2">
            {value.dir === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
            <span>{value.dir === "asc" ? "Ascending" : "Descending"}</span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
