const TARGETS = {
    win32: {
        x64: { nodePty: 'win32-x64', nativeBin: 'win32-x64-148', russh: 'win32-x64-msvc' },
        arm64: { nodePty: 'win32-arm64', nativeBin: 'win32-arm64-148', russh: 'win32-arm64-msvc' },
    },
    darwin: {
        x64: { nodePty: 'darwin-x64', nativeBin: 'darwin-x64-148', russh: 'darwin-x64' },
        arm64: { nodePty: 'darwin-arm64', nativeBin: 'darwin-arm64-148', russh: 'darwin-arm64' },
    },
    linux: {
        x64: { nodePty: 'linux-x64', nativeBin: 'linux-x64-148', russh: 'linux-x64-gnu' },
        arm64: { nodePty: 'linux-arm64', nativeBin: 'linux-arm64-148', russh: 'linux-arm64-gnu' },
        armv7l: { nodePty: 'linux-arm', nativeBin: 'linux-armv7l-148', russh: 'linux-arm-gnueabihf' },
    },
}

export function getReleaseTarget (platform = process.env.ISSH_TARGET_PLATFORM ?? process.platform, arch = process.env.ARCH ?? process.arch) {
    const normalizedArch = arch === 'arm' ? 'armv7l' : arch === 'x86_64' ? 'x64' : arch
    const target = TARGETS[platform]?.[normalizedArch]
    if (!target) {
        throw new Error(`Unsupported release target: ${platform}/${arch}`)
    }
    return {
        platform,
        arch: normalizedArch,
        electronAbi: '148',
        clink: normalizedArch === 'arm64' ? 'arm64' : 'x64',
        conpty: normalizedArch === 'arm64' ? 'win10-arm64' : 'win10-x64',
        ...target,
    }
}

export function configureReleaseTarget (platform = process.platform, arch = process.env.ARCH ?? process.arch) {
    const target = getReleaseTarget(platform, arch)
    process.env.ISSH_TARGET_PLATFORM = target.platform
    process.env.ISSH_TARGET_ARCH = target.arch
    process.env.ISSH_NODE_PTY_TARGET = target.nodePty
    process.env.ISSH_CLINK_ARCH = target.clink
    process.env.ISSH_NATIVE_BIN_TARGET = target.nativeBin
    process.env.ISSH_RUSSH_TARGET = target.russh
    process.env.ISSH_ELECTRON_ABI = target.electronAbi
    return target
}
