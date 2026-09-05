export function scheduleTimeout(callback: () => void, ms: number): () => void {
  const deadline = Date.now() + ms;
  const check = () => {
    const remaining = deadline - Date.now();
    // FiveM timers can use the previous tick as their starting time.
    if (remaining > 0) timer = setTimeout(check, remaining);
    else callback();
  };
  let timer = setTimeout(check, ms);
  return () => clearTimeout(timer);
}
