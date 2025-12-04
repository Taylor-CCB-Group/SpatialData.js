export function to_date(seconds: number): Date {
  const date = new Date(0);
  date.setUTCSeconds(seconds);
  return date;
}
