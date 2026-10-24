export function formatCount(value: number | null | undefined) {
  return value == null ? "—" : value.toLocaleString();
}

export function formatTimestamp(value: string | null | undefined) {
  if (!value || Number.isNaN(Date.parse(value))) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
