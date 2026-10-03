import { CompassIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { useI18n } from '../i18n/index.jsx';
import { EmptyState, buttonClass } from '../components/ui.jsx';

export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={CompassIcon}
      title={t('notfound.title')}
      body={t('notfound.body')}
      action={<Link to="/" className={buttonClass('secondary')}>{t('notfound.home')}</Link>}
    />
  );
}
