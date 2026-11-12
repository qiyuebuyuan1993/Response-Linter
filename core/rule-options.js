// Keep disabled entries in saved rules; filter only at execution time.
export function getRequiredContent(rule) {
  return (Array.isArray(rule?.requiredContent) ? rule.requiredContent : []).filter(
    item => typeof item === 'string' && item.trim() && item.trim() !== ',' &&
      rule.contentOptions?.[item]?.enabled !== false,
  );
}
