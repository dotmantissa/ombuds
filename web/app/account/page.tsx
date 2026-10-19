import { AccountDashboard } from '@/components/AccountDashboard';
import { Label } from '@/components/ui/primitives';
export const metadata = { title: 'Your cases and activity' };
export default function AccountPage() {
  return <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12"><Label>Your account</Label><h1 className="display mt-4 text-39">Cases, capital and payments.</h1><p className="mt-4 max-w-2xl text-16 text-text-2">Follow your cases and their histories, check underwriting exposure, and reconcile submitted transactions against the chain.</p><AccountDashboard /></section>;
}
