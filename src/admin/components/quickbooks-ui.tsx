import { Heading, Text } from "@medusajs/ui";

export const StatCard = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) => (
  <div className="flex flex-col gap-y-1 rounded-md border border-ui-border-base bg-ui-bg-base px-4 py-3">
    <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text size="large" weight="plus" leading="compact" className="truncate">
      {value}
    </Text>
    {hint ? (
      <Text size="xsmall" leading="compact" className="text-ui-fg-subtle">
        {hint}
      </Text>
    ) : null}
  </div>
);

export const SectionHeader = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => (
  <div className="flex flex-col gap-y-1">
    <Heading level="h2">{title}</Heading>
    {description ? (
      <Text size="small" leading="compact" className="text-ui-fg-subtle">
        {description}
      </Text>
    ) : null}
  </div>
);

export const formatDateTime = (value?: string | null) => {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};
