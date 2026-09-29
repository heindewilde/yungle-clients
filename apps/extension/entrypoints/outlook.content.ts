import { outlook } from '@/content/adapters';
import { run } from '@/content/mount';

// Registered at runtime by the background, only once the person has granted
// Outlook access — never listed in the manifest (see lib/webmail.ts).
export default defineContentScript({
  matches: ['https://outlook.live.com/*', 'https://outlook.office.com/*', 'https://outlook.office365.com/*'],
  registration: 'runtime',
  main() {
    run(outlook);
  },
});
