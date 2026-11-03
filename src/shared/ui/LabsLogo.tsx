type LabsLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is LABS. */
export const LabsLogo = ({ className = 'w-5 h-5' }: LabsLogoProps) => (
  <svg
    viewBox="0 0 32 32"
    role="img"
    aria-label="LABS"
    className={className}
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title>LABS</title>
    <rect width="32" height="32" rx="6" className="fill-muted text-muted-foreground stroke-border" strokeWidth="1.5" />
    <text
      x="16"
      y="20"
      textAnchor="middle"
      className="fill-muted-foreground font-mono font-bold"
      fontSize="9"
      letterSpacing="0.5"
    >
      LABS
    </text>
  </svg>
);

export default LabsLogo;
