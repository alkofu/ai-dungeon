import { Alert, Modal, NumberInput, Select, Stack } from "@mantine/core";
import { useSettings } from "../../settings/SettingsContext";

interface SettingsModalProps {
  opened: boolean;
  onClose: () => void;
}

export function SettingsModal({ opened, onClose }: SettingsModalProps) {
  const { settings, updateSettings, saveError } = useSettings();

  return (
    <Modal opened={opened} onClose={onClose} title="Settings" size="md">
      <Stack>
        {saveError !== null && (
          <Alert color="red" title="Failed to save settings" data-testid="settings-save-error">
            {saveError.message}
          </Alert>
        )}
        <Select
          label="Color scheme"
          value={settings.colorScheme}
          data={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "auto", label: "Auto" },
          ]}
          onChange={(value) => {
            if (value === "light" || value === "dark" || value === "auto") {
              updateSettings({ colorScheme: value }).catch((err) => {
                console.error("[SettingsModal] updateSettings rejected:", err);
              });
            }
          }}
        />
        <NumberInput
          label="Terminal font size"
          min={6}
          max={48}
          step={1}
          value={settings.terminal.fontSize}
          onChange={(value) => {
            // Reject empty string and non-finite values — do NOT call updateSettings
            // with NaN or '' as these would corrupt the persisted settings.
            if (typeof value === "number" && isFinite(value)) {
              updateSettings({ terminal: { fontSize: value } }).catch((err) => {
                console.error("[SettingsModal] updateSettings rejected:", err);
              });
            }
          }}
        />
      </Stack>
    </Modal>
  );
}
