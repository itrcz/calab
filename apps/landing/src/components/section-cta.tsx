import type { Locale } from '@/i18n';
import { getHome } from '@/i18n/home';
import { localePath } from '@/i18n/locales';
import { APP_URL } from '@/lib/site';
import { Button, cx } from './ui';

/**
 * The compact pair at the end of a section block: «Скачать» (the home page's #download) + «Начать бесплатно» (the web
 * app). Same labels, targets and Metrika goals as the hero buttons: the delegated listener in goal-tracking.tsx sees
 * the same APP_URL link, so nothing is counted here.
 */
export function SectionCta({ locale, className }: { locale: Locale; className?: string | undefined }) {
  const h = getHome(locale).hero;
  return (
    <div className={cx('section-cta', className)}>
      <Button href={`${localePath(locale)}#download`} size="md">
        {h.download}
      </Button>
      <Button href={APP_URL} variant="secondary" size="md">
        {h.startFree}
      </Button>
    </div>
  );
}
