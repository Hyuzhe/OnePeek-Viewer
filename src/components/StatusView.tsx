import { AlertCircle } from "lucide-react";
import { useI18n } from "../i18n";

interface LoadingProps {
  message?: string;
}

export function ViewerLoading({ message }: LoadingProps) {
  const { t } = useI18n();
  return (
    <div className="state-box">
      <span className="spinner-ring" aria-hidden="true" />
      <span>{message ?? t("common.loading")}</span>
    </div>
  );
}

interface ErrorProps {
  title?: string;
  detail: string;
}

export function ViewerError({ title, detail }: ErrorProps) {
  const { t } = useI18n();
  return (
    <div className="state-box error-box">
      <AlertCircle size={32} />
      <h3>{title ?? t("common.errorTitle")}</h3>
      <p>{detail}</p>
    </div>
  );
}
