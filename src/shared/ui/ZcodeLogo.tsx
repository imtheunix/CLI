type ZcodeLogoProps = {
  className?: string;
};

/** Rendered by the shared LLMProviderLogo when the provider is ZCode. */
export const ZcodeLogo = ({ className = 'w-5 h-5' }: ZcodeLogoProps) => (
  <svg
    viewBox="0 0 24 24"
    role="img"
    aria-label="ZCode"
    className={className}
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M4 4h16v3.5L9.5 16.5H20V20H4v-3.5L14.5 7.5H4V4Z" />
  </svg>
);

export default ZcodeLogo;
