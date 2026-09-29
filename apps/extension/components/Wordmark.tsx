import wordmark from '@/assets/wordmark.png';

export function Wordmark({ height = 22 }: { height?: number }) {
  return <img src={wordmark} alt="Yungle" className="wordmark" style={{ height }} />;
}
