type AgyLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is Antigravity / Gemini CLI. */
const AgyLogo = ({ className = 'w-5 h-5' }: AgyLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="Antigravity"
    className={className}
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M12 2C12 7.523 7.523 12 2 12C7.523 12 12 16.477 12 22C12 16.477 16.477 12 22 12C16.477 12 12 7.523 12 2Z" />
  </svg>
);

export default AgyLogo;
