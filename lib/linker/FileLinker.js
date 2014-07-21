// Dependencies ---------------------------------------------------------------
// ----------------------------------------------------------------------------
var Instruction = require('../data/Instruction'),
    Linker = require('./Linker');


// Source File Linking Logic --------------------------------------------------
// ----------------------------------------------------------------------------
var FileLinker = {

    // Static Methods ---------------------------------------------------------
    init: function(file) {

        if (file.unresolvedSizes.length) {

            // Resolve any outstanding sizes for data and variables
            file.unresolvedSizes.forEach(function(entry) {

                var size = Linker.resolveValue(
                    file,
                    entry.size,
                    entry.offset,
                    entry.index,
                    false
                );

                entry.size = typeof size === 'string' ? size.length : size;

            });

            // Clear the list
            file.unresolvedSizes.length = 0;

        }

        // Now recalculate the offsets of all entries with all sections
        file.sections.forEach(function(section) {
            section.calculateOffsets();
        });

        // For relative jumps, we check if the target is a OFFSET and switch
        // it with the actual instruction it points to.
        // This is required to preserve relative jump target through code
        // optimization were instructions and thus their size and address might
        // be altered.
        if (file.relativeJumpTargets.length) {

            file.relativeJumpTargets.forEach(function(instr) {

                var target = findInstructionByOffset(file, instr.offset, instr.arg.value);
                if (!target) {
                    file.addressError(
                        'Invalid jump offset, must point at the address of a valid instruction',
                        instr.index
                    );

                } else {
                    instr.arg = target;
                }

            });

            // Clear the list
            file.relativeJumpTargets.length = 0;

        }

    },

    link: function(file) {
        FileLinker.resolveInstructions(file);
        FileLinker.resolveDataBlocks(file);
    },

    resolveLocalLabel: function(file, localLabel) {

        // Find the first global label which sits infront of the target localLabel
        var i, l, parent = null;
        for(i = 0, l = file.labels.length; i < l; i++) {

            var label = file.labels[i];
            if (!label.parent) {
                if (label.index > localLabel.index) {
                    break;

                } else {
                    parent = label;
                }
            }

        }

        if (parent) {

            // Now find the first children with the labels name
            for(i = 0, l = parent.children.length; i < l; i++) {
                if (parent.children[i].name === localLabel.value) {
                    return parent.children[i];
                }
            }

        }

        return null;

    },

    resolveName: function(file, name) {

        var i, l;
        for(i = 0, l = file.labels.length; i < l; i++) {
            if (file.labels[i].name === name) {
                return file.labels[i];
            }
        }

        for(i = 0, l = file.variables.length; i < l; i++) {
            if (file.variables[i].name === name) {
                return file.variables[i];
            }
        }

        for(i = 0, l = file.constants.length; i < l; i++) {
            if (file.constants[i].name === name) {
                return file.constants[i];
            }
        }

        return null;

    },

    resolveInstructions: function(file) {

        file.instructions.forEach(function(instr) {

            if (instr.arg) {

                var value;

                // Handle targets of relative jump instructions
                if (instr.arg instanceof Instruction) {
                    value = instr.arg.offset - instr.offset;

                // Resolve the value of the instructions argument
                } else {
                    value = Linker.resolveValue(
                        file,
                        instr.arg,
                        instr.offset,
                        instr.arg.index,
                        instr.mnemonic === 'jr'
                    );
                }

                // Check if we could resolve the value
                if (value === null) {
                    file.referenceError(
                        '"' + instr.arg.value + '" could not be resolved',
                        instr.index
                    );

                // Validate signed argument range
                } else if (instr.isSigned && (value < -127 || value > 128)) {

                    if (instr.mnemonic === 'jr') {
                        file.addressError(
                            'Invalid relative jump value of ' + value + ' bytes, must be -127 to 128 bytes',
                            instr.index
                        );

                    } else {
                        file.argumentError(
                            'Invalid signed byte argument value of ' + value + ', must be between -127 and 128',
                            instr.index
                        );
                    }

                } else if (instr.isBit && (value < 0 || value > 7)) {
                    file.argumentError(
                        'Invalid bit index value of ' + value + ', must be between 0 and 7',
                        instr.index
                    );

                } else if (instr.bits === 8 && (value < -127 || value > 255)) {
                    file.argumentError(
                        'Invalid byte argument value of ' + value + ', must be between -128 and 255',
                        instr.index
                    );

                } else if (instr.bits === 16 && (value < -32767 || value > 65535)) {
                    if (instr.mnemonic === 'jp' || instr.mnemonic === 'call') {
                        file.addressError(
                            'Invalid jump address value of ' + value + ', must be between 0 and 65535',
                            instr.index
                        );

                    } else {
                        file.argumentError(
                            'Invalid word argument value of ' + value + ', must be between -32767 and 65535',
                            instr.index
                        );
                    }

                // Convert signed values to twos complement
                } else if (value < 0) {
                    if (instr.bits === 8) {

                        // Correct jump offsets for relative jumps
                        if (instr.mnemonic === 'jr') {
                            if (value < 0) {
                                value -= 1;
                            }
                        }

                        value = ((~Math.abs(value) + 1) + 255) % 255;

                    } else {
                        value = ((~value + 1) + 65535) % 65535;
                    }

                } else {

                    // Correct jump offsets for relative jumps
                    if (instr.mnemonic === 'jr') {
                        if (value > 0) {
                            value -= 2;
                        }
                    }

                }

                // Replace arg with resolved value
                instr.resolvedArg = value;

            }

        });

    },

    resolveDataBlocks: function(file) {

        file.dataBlocks.forEach(function(data) {

            for(var i = 0, l = data.values.length; i < l; i++) {

                var value = data.values[i];

                // Resolve the correct value
                var resolved = Linker.resolveValue(
                    file,
                    value,
                    value.offset,
                    value.index,
                    false
                );

                // DS can also store strings by splitting them
                if (data.isFixedSize) {

                    // Only strings can be contained in fixed sized sections
                    if (typeof resolved !== 'string') {
                        file.argumentError(
                            'Only string values are allow for fixed sized data storage',
                            data.index
                        );

                    } else if (resolved.length > data.size) {
                        file.argumentError(
                            'String length of ' + resolved.length + ' exceeds allocated storage size of ' + data.size + ' bytes',
                            data.index
                        );
                    }

                    // Pad strings with 0x00
                    value = new Array(data.size);
                    for(var e = 0; e < data.size; e++) {
                        if (e < resolved.length) {
                            value[e] = resolved.charCodeAt(e);

                        } else {
                            value[e] = 0;
                        }
                    }

                    data.resolvedValues = value;

                // Check bit width
                } else if (data.bits === 8 && (resolved < -127 || resolved > 255)) {
                    file.argumentError(
                        'Invalid byte argument value of ' + value + ' for data storage, must be between -128 and 255',
                        data.index
                    );

                } else if (data.bits === 16 && (resolved < -32767 || resolved > 65535)) {
                    file.argumentError(
                        'Invalid workd argument value of ' + value + ' for data storage, must be between -32767 and 65535',
                        data.index
                    );

                // Convert signed values to twos complement
                } else if (resolved < 0) {
                    if (data.bits === 8) {
                        data.resolvedValues[i] = ((~resolved + 1) + 255) % 255;

                    } else {
                        data.resolvedValues[i] = ((~resolved + 1) + 65535) % 65535;
                    }

                } else {
                    data.resolvedValues[i] = resolved;
                }

            }

        });

    }

};


// Helpers --------------------------------------------------------------------
function findInstructionByOffset(file, address, offset) {

    // Correct for instruction size
    if (offset < 0) {
        offset -= 1;
    }

    var target = address + offset;
    for(var i = 0; i < file.instructions.length; i++) {
        var instr = file.instructions[i];
        if (instr.offset === target) {
            return instr;
        }
    }

    return null;

}


// Exports --------------------------------------------------------------------
module.exports = FileLinker;
