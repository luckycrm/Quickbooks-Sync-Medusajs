import { Badge, Container, Heading, Text } from "@medusajs/ui"

type QuickbooksPlaceholderPageProps = {
  title: string
  description: string
}

const QuickbooksPlaceholderPage = ({
  title,
  description,
}: QuickbooksPlaceholderPageProps) => {
  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">{title}</Heading>
          <Text className="text-ui-fg-subtle mt-1">{description}</Text>
        </div>
        <Badge color="blue">Placeholder</Badge>
      </div>

      <div className="px-6 py-8">
        <Text className="text-ui-fg-subtle">
          This section is ready for the next step of the QuickBooks integration.
        </Text>
      </div>
    </Container>
  )
}

export default QuickbooksPlaceholderPage
