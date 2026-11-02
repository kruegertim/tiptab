export default {
    InputPanelState: {OFF: 0, ON: 1, TOGGLE: 2},
    InputContentPurpose: {NORMAL: 0, ALPHA: 1, DIGITS: 2, NUMBER: 3, PHONE: 4, URL: 5, EMAIL: 6, NAME: 7,
        PASSWORD: 8, DATE: 9, TIME: 10, DATETIME: 11, TERMINAL: 12},
    InputContentHintFlags: {COMPLETION: 1, SPELLCHECK: 2, AUTO_CAPITALIZATION: 4, LOWERCASE: 8,
        UPPERCASE: 16, TITLECASE: 32, HIDDEN_TEXT: 64, SENSITIVE_DATA: 128, LATIN: 256, MULTILINE: 512},
    Text: class Text {},
};
