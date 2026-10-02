import { FileWizard } from '@/components/FileWizard';
import { Label } from '@/components/ui/primitives';
import { planRules } from '@/lib/chainReads';
import { reasonCodes, statesList } from '@/lib/sources';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'File a case' };

export default async function FilePage() {
  const [rules, states, codes] = await Promise.all([planRules(), statesList(), reasonCodes()]);
  const usable = rules.filter((rule) => rule.active);

  return (
    <section className="mx-auto max-w-[1240px] px-4 pb-20 pt-12">
      <div className="seq set-type" style={{ ['--i' as string]: 0 }}>
        <Label>Four steps, about ten minutes</Label>
        <h1 className="display mt-4 max-w-[36rem] text-49 text-text">
          Let us have a look at that denial letter.
        </h1>
        <p className="mt-5 max-w-[44rem] text-16 text-text-2">
          Paste it in whole. We strip out everything that identifies you before anything is signed,
          and we show you exactly what was removed so you can check our work. If anything
          identifying survives, the filing is refused rather than sent.
        </p>
      </div>

      <FileWizard
        rules={usable.map((rule) => ({
          planId: rule.plan_id,
          insurer: rule.insurer,
          familyId: rule.family_id,
          bulletinNumber: rule.bulletin_number,
          bulletinTitle: rule.bulletin_title,
          bulletinUrl: rule.bulletin_url,
          cmsDisplayId: rule.cms_display_id,
          cmsSourceUrl: rule.cms_source_url,
          effectiveTo: rule.effective_to,
        }))}
        states={states}
        reasonCodes={codes}
      />
    </section>
  );
}
