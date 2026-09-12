/* Only OS errno constants from the compilation platform; no libuv domain. */
#ifndef HOST_ERRNO_H
#define HOST_ERRNO_H
#include <errno.h>
static const char *host_errno_name(int value) {
#ifdef E2BIG
  if (value == E2BIG) return "E2BIG";
#endif
#ifdef EACCES
  if (value == EACCES) return "EACCES";
#endif
#ifdef EADDRINUSE
  if (value == EADDRINUSE) return "EADDRINUSE";
#endif
#ifdef EADDRNOTAVAIL
  if (value == EADDRNOTAVAIL) return "EADDRNOTAVAIL";
#endif
#ifdef EADV
  if (value == EADV) return "EADV";
#endif
#ifdef EAFNOSUPPORT
  if (value == EAFNOSUPPORT) return "EAFNOSUPPORT";
#endif
#ifdef EAGAIN
  if (value == EAGAIN) return "EAGAIN";
#endif
#ifdef EALREADY
  if (value == EALREADY) return "EALREADY";
#endif
#ifdef EAUTH
  if (value == EAUTH) return "EAUTH";
#endif
#ifdef EBADE
  if (value == EBADE) return "EBADE";
#endif
#ifdef EBADF
  if (value == EBADF) return "EBADF";
#endif
#ifdef EBADFD
  if (value == EBADFD) return "EBADFD";
#endif
#ifdef EBADMSG
  if (value == EBADMSG) return "EBADMSG";
#endif
#ifdef EBADR
  if (value == EBADR) return "EBADR";
#endif
#ifdef EBADRPC
  if (value == EBADRPC) return "EBADRPC";
#endif
#ifdef EBADRQC
  if (value == EBADRQC) return "EBADRQC";
#endif
#ifdef EBADSLT
  if (value == EBADSLT) return "EBADSLT";
#endif
#ifdef EBFONT
  if (value == EBFONT) return "EBFONT";
#endif
#ifdef EBUSY
  if (value == EBUSY) return "EBUSY";
#endif
#ifdef ECANCELED
  if (value == ECANCELED) return "ECANCELED";
#endif
#ifdef ECHILD
  if (value == ECHILD) return "ECHILD";
#endif
#ifdef ECHRNG
  if (value == ECHRNG) return "ECHRNG";
#endif
#ifdef ECOMM
  if (value == ECOMM) return "ECOMM";
#endif
#ifdef ECONNABORTED
  if (value == ECONNABORTED) return "ECONNABORTED";
#endif
#ifdef ECONNREFUSED
  if (value == ECONNREFUSED) return "ECONNREFUSED";
#endif
#ifdef ECONNRESET
  if (value == ECONNRESET) return "ECONNRESET";
#endif
#ifdef EDEADLK
  if (value == EDEADLK) return "EDEADLK";
#endif
#ifdef EDEADLOCK
  if (value == EDEADLOCK) return "EDEADLOCK";
#endif
#ifdef EDESTADDRREQ
  if (value == EDESTADDRREQ) return "EDESTADDRREQ";
#endif
#ifdef EDOM
  if (value == EDOM) return "EDOM";
#endif
#ifdef EDOTDOT
  if (value == EDOTDOT) return "EDOTDOT";
#endif
#ifdef EDQUOT
  if (value == EDQUOT) return "EDQUOT";
#endif
#ifdef EEXIST
  if (value == EEXIST) return "EEXIST";
#endif
#ifdef EFAULT
  if (value == EFAULT) return "EFAULT";
#endif
#ifdef EFBIG
  if (value == EFBIG) return "EFBIG";
#endif
#ifdef EFTYPE
  if (value == EFTYPE) return "EFTYPE";
#endif
#ifdef EHOSTDOWN
  if (value == EHOSTDOWN) return "EHOSTDOWN";
#endif
#ifdef EHOSTUNREACH
  if (value == EHOSTUNREACH) return "EHOSTUNREACH";
#endif
#ifdef EIDRM
  if (value == EIDRM) return "EIDRM";
#endif
#ifdef EILSEQ
  if (value == EILSEQ) return "EILSEQ";
#endif
#ifdef EINPROGRESS
  if (value == EINPROGRESS) return "EINPROGRESS";
#endif
#ifdef EINTR
  if (value == EINTR) return "EINTR";
#endif
#ifdef EINVAL
  if (value == EINVAL) return "EINVAL";
#endif
#ifdef EIO
  if (value == EIO) return "EIO";
#endif
#ifdef EISCONN
  if (value == EISCONN) return "EISCONN";
#endif
#ifdef EISDIR
  if (value == EISDIR) return "EISDIR";
#endif
#ifdef EISNAM
  if (value == EISNAM) return "EISNAM";
#endif
#ifdef EKEYEXPIRED
  if (value == EKEYEXPIRED) return "EKEYEXPIRED";
#endif
#ifdef EKEYREJECTED
  if (value == EKEYREJECTED) return "EKEYREJECTED";
#endif
#ifdef EKEYREVOKED
  if (value == EKEYREVOKED) return "EKEYREVOKED";
#endif
#ifdef EL2HLT
  if (value == EL2HLT) return "EL2HLT";
#endif
#ifdef EL2NSYNC
  if (value == EL2NSYNC) return "EL2NSYNC";
#endif
#ifdef EL3HLT
  if (value == EL3HLT) return "EL3HLT";
#endif
#ifdef EL3RST
  if (value == EL3RST) return "EL3RST";
#endif
#ifdef ELIBACC
  if (value == ELIBACC) return "ELIBACC";
#endif
#ifdef ELIBBAD
  if (value == ELIBBAD) return "ELIBBAD";
#endif
#ifdef ELIBEXEC
  if (value == ELIBEXEC) return "ELIBEXEC";
#endif
#ifdef ELIBMAX
  if (value == ELIBMAX) return "ELIBMAX";
#endif
#ifdef ELIBSCN
  if (value == ELIBSCN) return "ELIBSCN";
#endif
#ifdef ELNRNG
  if (value == ELNRNG) return "ELNRNG";
#endif
#ifdef ELOOP
  if (value == ELOOP) return "ELOOP";
#endif
#ifdef EMEDIUMTYPE
  if (value == EMEDIUMTYPE) return "EMEDIUMTYPE";
#endif
#ifdef EMFILE
  if (value == EMFILE) return "EMFILE";
#endif
#ifdef EMLINK
  if (value == EMLINK) return "EMLINK";
#endif
#ifdef EMSGSIZE
  if (value == EMSGSIZE) return "EMSGSIZE";
#endif
#ifdef EMULTIHOP
  if (value == EMULTIHOP) return "EMULTIHOP";
#endif
#ifdef ENAMETOOLONG
  if (value == ENAMETOOLONG) return "ENAMETOOLONG";
#endif
#ifdef ENAVAIL
  if (value == ENAVAIL) return "ENAVAIL";
#endif
#ifdef ENEEDAUTH
  if (value == ENEEDAUTH) return "ENEEDAUTH";
#endif
#ifdef ENETDOWN
  if (value == ENETDOWN) return "ENETDOWN";
#endif
#ifdef ENETRESET
  if (value == ENETRESET) return "ENETRESET";
#endif
#ifdef ENETUNREACH
  if (value == ENETUNREACH) return "ENETUNREACH";
#endif
#ifdef ENFILE
  if (value == ENFILE) return "ENFILE";
#endif
#ifdef ENOANO
  if (value == ENOANO) return "ENOANO";
#endif
#ifdef ENOATTR
  if (value == ENOATTR) return "ENOATTR";
#endif
#ifdef ENOBUFS
  if (value == ENOBUFS) return "ENOBUFS";
#endif
#ifdef ENOCSI
  if (value == ENOCSI) return "ENOCSI";
#endif
#ifdef ENODATA
  if (value == ENODATA) return "ENODATA";
#endif
#ifdef ENODEV
  if (value == ENODEV) return "ENODEV";
#endif
#ifdef ENOENT
  if (value == ENOENT) return "ENOENT";
#endif
#ifdef ENOEXEC
  if (value == ENOEXEC) return "ENOEXEC";
#endif
#ifdef ENOKEY
  if (value == ENOKEY) return "ENOKEY";
#endif
#ifdef ENOLCK
  if (value == ENOLCK) return "ENOLCK";
#endif
#ifdef ENOLINK
  if (value == ENOLINK) return "ENOLINK";
#endif
#ifdef ENOMEDIUM
  if (value == ENOMEDIUM) return "ENOMEDIUM";
#endif
#ifdef ENOMEM
  if (value == ENOMEM) return "ENOMEM";
#endif
#ifdef ENOMSG
  if (value == ENOMSG) return "ENOMSG";
#endif
#ifdef ENONET
  if (value == ENONET) return "ENONET";
#endif
#ifdef ENOPKG
  if (value == ENOPKG) return "ENOPKG";
#endif
#ifdef ENOPOLICY
  if (value == ENOPOLICY) return "ENOPOLICY";
#endif
#ifdef ENOPROTOOPT
  if (value == ENOPROTOOPT) return "ENOPROTOOPT";
#endif
#ifdef ENOSPC
  if (value == ENOSPC) return "ENOSPC";
#endif
#ifdef ENOSR
  if (value == ENOSR) return "ENOSR";
#endif
#ifdef ENOSTR
  if (value == ENOSTR) return "ENOSTR";
#endif
#ifdef ENOSYS
  if (value == ENOSYS) return "ENOSYS";
#endif
#ifdef ENOTBLK
  if (value == ENOTBLK) return "ENOTBLK";
#endif
#ifdef ENOTCONN
  if (value == ENOTCONN) return "ENOTCONN";
#endif
#ifdef ENOTDIR
  if (value == ENOTDIR) return "ENOTDIR";
#endif
#ifdef ENOTEMPTY
  if (value == ENOTEMPTY) return "ENOTEMPTY";
#endif
#ifdef ENOTNAM
  if (value == ENOTNAM) return "ENOTNAM";
#endif
#ifdef ENOTRECOVERABLE
  if (value == ENOTRECOVERABLE) return "ENOTRECOVERABLE";
#endif
#ifdef ENOTSOCK
  if (value == ENOTSOCK) return "ENOTSOCK";
#endif
#ifdef ENOTSUP
  if (value == ENOTSUP) return "ENOTSUP";
#endif
#ifdef EOPNOTSUPP
  if (value == EOPNOTSUPP) return "EOPNOTSUPP";
#endif
#ifdef ENOTTY
  if (value == ENOTTY) return "ENOTTY";
#endif
#ifdef ENOTUNIQ
  if (value == ENOTUNIQ) return "ENOTUNIQ";
#endif
#ifdef ENXIO
  if (value == ENXIO) return "ENXIO";
#endif
#ifdef EOVERFLOW
  if (value == EOVERFLOW) return "EOVERFLOW";
#endif
#ifdef EOWNERDEAD
  if (value == EOWNERDEAD) return "EOWNERDEAD";
#endif
#ifdef EPERM
  if (value == EPERM) return "EPERM";
#endif
#ifdef EPFNOSUPPORT
  if (value == EPFNOSUPPORT) return "EPFNOSUPPORT";
#endif
#ifdef EPIPE
  if (value == EPIPE) return "EPIPE";
#endif
#ifdef EPROCLIM
  if (value == EPROCLIM) return "EPROCLIM";
#endif
#ifdef EPROCUNAVAIL
  if (value == EPROCUNAVAIL) return "EPROCUNAVAIL";
#endif
#ifdef EPROGMISMATCH
  if (value == EPROGMISMATCH) return "EPROGMISMATCH";
#endif
#ifdef EPROGUNAVAIL
  if (value == EPROGUNAVAIL) return "EPROGUNAVAIL";
#endif
#ifdef EPROTO
  if (value == EPROTO) return "EPROTO";
#endif
#ifdef EPROTONOSUPPORT
  if (value == EPROTONOSUPPORT) return "EPROTONOSUPPORT";
#endif
#ifdef EPROTOTYPE
  if (value == EPROTOTYPE) return "EPROTOTYPE";
#endif
#ifdef EQFULL
  if (value == EQFULL) return "EQFULL";
#endif
#ifdef ERANGE
  if (value == ERANGE) return "ERANGE";
#endif
#ifdef EREMCHG
  if (value == EREMCHG) return "EREMCHG";
#endif
#ifdef EREMOTE
  if (value == EREMOTE) return "EREMOTE";
#endif
#ifdef EREMOTEIO
  if (value == EREMOTEIO) return "EREMOTEIO";
#endif
#ifdef ERESTART
  if (value == ERESTART) return "ERESTART";
#endif
#ifdef ERFKILL
  if (value == ERFKILL) return "ERFKILL";
#endif
#ifdef EROFS
  if (value == EROFS) return "EROFS";
#endif
#ifdef ERPCMISMATCH
  if (value == ERPCMISMATCH) return "ERPCMISMATCH";
#endif
#ifdef ESHUTDOWN
  if (value == ESHUTDOWN) return "ESHUTDOWN";
#endif
#ifdef ESOCKTNOSUPPORT
  if (value == ESOCKTNOSUPPORT) return "ESOCKTNOSUPPORT";
#endif
#ifdef ESPIPE
  if (value == ESPIPE) return "ESPIPE";
#endif
#ifdef ESRCH
  if (value == ESRCH) return "ESRCH";
#endif
#ifdef ESRMNT
  if (value == ESRMNT) return "ESRMNT";
#endif
#ifdef ESTALE
  if (value == ESTALE) return "ESTALE";
#endif
#ifdef ESTRPIPE
  if (value == ESTRPIPE) return "ESTRPIPE";
#endif
#ifdef ETIME
  if (value == ETIME) return "ETIME";
#endif
#ifdef ETIMEDOUT
  if (value == ETIMEDOUT) return "ETIMEDOUT";
#endif
#ifdef ETOOMANYREFS
  if (value == ETOOMANYREFS) return "ETOOMANYREFS";
#endif
#ifdef ETXTBSY
  if (value == ETXTBSY) return "ETXTBSY";
#endif
#ifdef EUCLEAN
  if (value == EUCLEAN) return "EUCLEAN";
#endif
#ifdef EUNATCH
  if (value == EUNATCH) return "EUNATCH";
#endif
#ifdef EUSERS
  if (value == EUSERS) return "EUSERS";
#endif
#ifdef EWOULDBLOCK
  if (value == EWOULDBLOCK) return "EWOULDBLOCK";
#endif
#ifdef EXDEV
  if (value == EXDEV) return "EXDEV";
#endif
#ifdef EXFULL
  if (value == EXFULL) return "EXFULL";
#endif
  return "UNKNOWN";
}
#endif
