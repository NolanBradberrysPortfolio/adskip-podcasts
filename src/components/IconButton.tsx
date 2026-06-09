import { Pressable, StyleSheet, Text, ViewStyle } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

type Props = {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  style?: ViewStyle;
};

const colors = {
  primary: '#F8FAF7',
  secondary: '#122620',
  ghost: '#122620',
  danger: '#7F1D1D',
};

export function IconButton({ icon: Icon, label, onPress, disabled, variant = 'secondary', style }: Props) {
  const iconColor = disabled ? '#4B5563' : colors[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style,
      ]}
    >
      <Icon size={18} strokeWidth={2.25} color={iconColor} />
      <Text style={[styles.label, styles[`${variant}Label`], disabled && styles.disabledLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    borderWidth: 1,
  },
  primary: {
    backgroundColor: '#122620',
    borderColor: '#122620',
  },
  secondary: {
    backgroundColor: '#FFFFFF',
    borderColor: '#CAD3CB',
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  danger: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
  },
  primaryLabel: {
    color: '#F8FAF7',
  },
  secondaryLabel: {
    color: '#122620',
  },
  ghostLabel: {
    color: '#122620',
  },
  dangerLabel: {
    color: '#7F1D1D',
  },
  pressed: {
    opacity: 0.8,
    transform: [{ translateY: 1 }],
  },
  disabled: {
    backgroundColor: '#F3F4F6',
    borderColor: '#D1D5DB',
  },
  disabledLabel: {
    color: '#4B5563',
  },
});
