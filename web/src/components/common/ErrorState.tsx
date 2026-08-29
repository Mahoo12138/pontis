import { Button, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { tokens } from '../../styles/semantic-tokens.css';

interface ErrorStateProps {
  message?: string;
  onRetry: () => void;
}

/** Query failure placeholder with a retry action. */
export default function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        minHeight: 160,
        color: tokens.textSecondary,
        gap: 8,
      }}
    >
      <IconAlertCircle size={32} stroke={1.2} style={{ color: tokens.syncError }} />
      <Text fz="sm">{message ?? t('error_generic')}</Text>
      <Button size="compact-xs" variant="subtle" color="coolGray" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}
