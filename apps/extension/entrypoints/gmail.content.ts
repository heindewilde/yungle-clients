import { gmail } from '@/content/adapters';
import { run } from '@/content/mount';

// Registered at runtime by the background, only once the person has granted
// Gmail access — never listed in the manifest (see lib/webmail.ts).
export default defineContentScript({
  matches: ['https://mail.google.com/*'],
  registration: 'runtime',
  main() {
    run(gmail);
  },
});
