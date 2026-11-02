export default {
    signal_lookup(name, gtype) { return gtype?.signals?.includes(name) ? 1 : 0; },
};
